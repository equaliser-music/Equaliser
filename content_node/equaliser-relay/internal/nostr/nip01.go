package nostr

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Message types for incoming WebSocket messages.
const (
	MsgTypeEvent = "EVENT"
	MsgTypeReq   = "REQ"
	MsgTypeClose = "CLOSE"
	MsgTypeCount = "COUNT"
)

// Filter represents a NIP-01 subscription filter.
type Filter struct {
	IDs     []string            `json:"ids,omitempty"`
	Authors []string            `json:"authors,omitempty"`
	Kinds   []int               `json:"kinds,omitempty"`
	Tags    map[string][]string `json:"-"` // #e, #p, #d, #app, #content-type, etc.
	Since   *int64              `json:"since,omitempty"`
	Until   *int64              `json:"until,omitempty"`
	Limit   *int                `json:"limit,omitempty"`
}

// UnmarshalJSON implements custom JSON unmarshalling for Filter.
// Any key starting with '#' is treated as a tag filter.
func (f *Filter) UnmarshalJSON(data []byte) error {
	// First unmarshal known fields into a temporary struct
	type filterBasic struct {
		IDs     []string `json:"ids,omitempty"`
		Authors []string `json:"authors,omitempty"`
		Kinds   []int    `json:"kinds,omitempty"`
		Since   *int64   `json:"since,omitempty"`
		Until   *int64   `json:"until,omitempty"`
		Limit   *int     `json:"limit,omitempty"`
	}

	var basic filterBasic
	if err := json.Unmarshal(data, &basic); err != nil {
		return err
	}

	f.IDs = basic.IDs
	f.Authors = basic.Authors
	f.Kinds = basic.Kinds
	f.Since = basic.Since
	f.Until = basic.Until
	f.Limit = basic.Limit

	// Now unmarshal into a raw map to find tag filters
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	f.Tags = make(map[string][]string)
	for key, val := range raw {
		if strings.HasPrefix(key, "#") {
			tagName := key[1:] // strip the #
			var values []string
			if err := json.Unmarshal(val, &values); err != nil {
				return fmt.Errorf("invalid tag filter %s: %w", key, err)
			}
			f.Tags[tagName] = values
		}
	}

	return nil
}

// MarshalJSON implements custom JSON marshalling for Filter.
func (f Filter) MarshalJSON() ([]byte, error) {
	m := make(map[string]interface{})

	if len(f.IDs) > 0 {
		m["ids"] = f.IDs
	}
	if len(f.Authors) > 0 {
		m["authors"] = f.Authors
	}
	if len(f.Kinds) > 0 {
		m["kinds"] = f.Kinds
	}
	if f.Since != nil {
		m["since"] = *f.Since
	}
	if f.Until != nil {
		m["until"] = *f.Until
	}
	if f.Limit != nil {
		m["limit"] = *f.Limit
	}
	for tagName, values := range f.Tags {
		m["#"+tagName] = values
	}

	return json.Marshal(m)
}

// MatchesEvent checks if an event matches this filter (in-memory matching for subscription notifications).
func (f *Filter) MatchesEvent(event *Event) bool {
	// Check IDs
	if len(f.IDs) > 0 {
		found := false
		for _, id := range f.IDs {
			if event.ID == id || strings.HasPrefix(event.ID, id) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}

	// Check authors
	if len(f.Authors) > 0 {
		found := false
		for _, author := range f.Authors {
			if event.PubKey == author || strings.HasPrefix(event.PubKey, author) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}

	// Check kinds
	if len(f.Kinds) > 0 {
		found := false
		for _, kind := range f.Kinds {
			if event.Kind == kind {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}

	// Check since
	if f.Since != nil && event.CreatedAt < *f.Since {
		return false
	}

	// Check until
	if f.Until != nil && event.CreatedAt > *f.Until {
		return false
	}

	// Check tags
	for tagName, filterValues := range f.Tags {
		eventValues := event.GetTagValues(tagName)
		if len(eventValues) == 0 {
			return false
		}
		// Event must have at least one value matching the filter
		found := false
		for _, fv := range filterValues {
			for _, ev := range eventValues {
				if ev == fv {
					found = true
					break
				}
			}
			if found {
				break
			}
		}
		if !found {
			return false
		}
	}

	return true
}

// ParseMessage parses an incoming WebSocket message into its type and payload.
func ParseMessage(data []byte) (string, json.RawMessage, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return "", nil, fmt.Errorf("invalid message: not a JSON array")
	}

	if len(arr) < 1 {
		return "", nil, fmt.Errorf("invalid message: empty array")
	}

	var msgType string
	if err := json.Unmarshal(arr[0], &msgType); err != nil {
		return "", nil, fmt.Errorf("invalid message: first element is not a string")
	}

	// Re-marshal the full array for further processing
	return msgType, data, nil
}

// ParseEventMessage parses an EVENT message: ["EVENT", <event>]
func ParseEventMessage(data []byte) (*Event, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return nil, err
	}
	if len(arr) < 2 {
		return nil, fmt.Errorf("EVENT message requires at least 2 elements")
	}

	var event Event
	if err := json.Unmarshal(arr[1], &event); err != nil {
		return nil, fmt.Errorf("invalid event: %w", err)
	}
	return &event, nil
}

// ParseReqMessage parses a REQ message: ["REQ", <sub_id>, <filter>, ...]
func ParseReqMessage(data []byte) (string, []Filter, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return "", nil, err
	}
	if len(arr) < 3 {
		return "", nil, fmt.Errorf("REQ message requires at least 3 elements")
	}

	var subID string
	if err := json.Unmarshal(arr[1], &subID); err != nil {
		return "", nil, fmt.Errorf("invalid subscription ID: %w", err)
	}

	var filters []Filter
	for i := 2; i < len(arr); i++ {
		var f Filter
		if err := json.Unmarshal(arr[i], &f); err != nil {
			return "", nil, fmt.Errorf("invalid filter %d: %w", i-2, err)
		}
		filters = append(filters, f)
	}

	return subID, filters, nil
}

// ParseCloseMessage parses a CLOSE message: ["CLOSE", <sub_id>]
func ParseCloseMessage(data []byte) (string, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return "", err
	}
	if len(arr) < 2 {
		return "", fmt.Errorf("CLOSE message requires at least 2 elements")
	}

	var subID string
	if err := json.Unmarshal(arr[1], &subID); err != nil {
		return "", fmt.Errorf("invalid subscription ID: %w", err)
	}
	return subID, nil
}

// ParseCountMessage parses a COUNT message: ["COUNT", <sub_id>, <filter>, ...]
func ParseCountMessage(data []byte) (string, []Filter, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return "", nil, err
	}
	if len(arr) < 3 {
		return "", nil, fmt.Errorf("COUNT message requires at least 3 elements")
	}

	var subID string
	if err := json.Unmarshal(arr[1], &subID); err != nil {
		return "", nil, fmt.Errorf("invalid subscription ID: %w", err)
	}

	var filters []Filter
	for i := 2; i < len(arr); i++ {
		var f Filter
		if err := json.Unmarshal(arr[i], &f); err != nil {
			return "", nil, fmt.Errorf("invalid filter %d: %w", i-2, err)
		}
		filters = append(filters, f)
	}

	return subID, filters, nil
}

// BuildEventMessage builds an outgoing EVENT message: ["EVENT", <sub_id>, <event_json>]
func BuildEventMessage(subID string, rawEvent json.RawMessage) ([]byte, error) {
	return json.Marshal([]interface{}{"EVENT", subID, rawEvent})
}

// BuildEOSEMessage builds an EOSE message: ["EOSE", <sub_id>]
func BuildEOSEMessage(subID string) ([]byte, error) {
	return json.Marshal([]string{"EOSE", subID})
}

// BuildOKMessage builds an OK message: ["OK", <event_id>, <accepted>, <message>]
func BuildOKMessage(eventID string, accepted bool, message string) ([]byte, error) {
	return json.Marshal([]interface{}{"OK", eventID, accepted, message})
}

// BuildNoticeMessage builds a NOTICE message: ["NOTICE", <message>]
func BuildNoticeMessage(message string) ([]byte, error) {
	return json.Marshal([]string{"NOTICE", message})
}

// BuildCountMessage builds a COUNT response: ["COUNT", <sub_id>, {"count": N}]
func BuildCountMessage(subID string, count int64) ([]byte, error) {
	return json.Marshal([]interface{}{"COUNT", subID, map[string]int64{"count": count}})
}
