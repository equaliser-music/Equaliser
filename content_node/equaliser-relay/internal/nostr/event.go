package nostr

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
)

// Event represents a NOSTR event (NIP-01).
type Event struct {
	ID        string     `json:"id"`
	PubKey    string     `json:"pubkey"`
	CreatedAt int64      `json:"created_at"`
	Kind      int        `json:"kind"`
	Tags      [][]string `json:"tags"`
	Content   string     `json:"content"`
	Sig       string     `json:"sig"`
}

// Serialize produces the canonical JSON array for event ID computation:
// [0, <pubkey>, <created_at>, <kind>, <tags>, <content>]
func (e *Event) Serialize() ([]byte, error) {
	// Tags must serialize as empty array if nil
	tags := e.Tags
	if tags == nil {
		tags = [][]string{}
	}
	arr := []interface{}{0, e.PubKey, e.CreatedAt, e.Kind, tags, e.Content}
	return json.Marshal(arr)
}

// ComputeID returns the hex-encoded SHA-256 hash of the serialized event.
func (e *Event) ComputeID() (string, error) {
	serialized, err := e.Serialize()
	if err != nil {
		return "", fmt.Errorf("serialize: %w", err)
	}
	hash := sha256.Sum256(serialized)
	return hex.EncodeToString(hash[:]), nil
}

// ValidateID checks that the event ID matches the SHA-256 of the serialized event.
func (e *Event) ValidateID() bool {
	computed, err := e.ComputeID()
	if err != nil {
		return false
	}
	return computed == e.ID
}

// ValidateSignature verifies the BIP-340 Schnorr signature against the event ID using the pubkey.
func (e *Event) ValidateSignature() bool {
	// Decode pubkey (32 bytes, x-only)
	pubkeyBytes, err := hex.DecodeString(e.PubKey)
	if err != nil || len(pubkeyBytes) != 32 {
		return false
	}

	// Decode signature (64 bytes)
	sigBytes, err := hex.DecodeString(e.Sig)
	if err != nil || len(sigBytes) != 64 {
		return false
	}

	// Decode event ID (the message that was signed)
	idBytes, err := hex.DecodeString(e.ID)
	if err != nil || len(idBytes) != 32 {
		return false
	}

	// Parse public key (x-only BIP-340)
	pubkey, err := btcec.ParsePubKey(append([]byte{0x02}, pubkeyBytes...))
	if err != nil {
		return false
	}

	// Parse BIP-340 Schnorr signature
	sig, err := schnorr.ParseSignature(sigBytes)
	if err != nil {
		return false
	}

	// Verify using BIP-340
	return sig.Verify(idBytes, pubkey)
}

// Validate checks both ID and signature.
func (e *Event) Validate() (bool, string) {
	if !e.ValidateID() {
		return false, "invalid: event ID does not match"
	}
	if !e.ValidateSignature() {
		return false, "invalid: signature verification failed"
	}
	return true, ""
}

// GetTagValue returns the first value for a given tag name, or empty string.
func (e *Event) GetTagValue(tagName string) string {
	for _, tag := range e.Tags {
		if len(tag) >= 2 && tag[0] == tagName {
			return tag[1]
		}
	}
	return ""
}

// GetTagValues returns all values for a given tag name.
func (e *Event) GetTagValues(tagName string) []string {
	var values []string
	for _, tag := range e.Tags {
		if len(tag) >= 2 && tag[0] == tagName {
			values = append(values, tag[1])
		}
	}
	return values
}

// GetDTag returns the "d" tag value (for parameterised replaceable events).
func (e *Event) GetDTag() string {
	return e.GetTagValue("d")
}

// IsReplaceable returns true for Kind 0, 3, 10000-19999.
func IsReplaceable(kind int) bool {
	return kind == 0 || kind == 3 || (kind >= 10000 && kind < 20000)
}

// IsParameterisedReplaceable returns true for Kind 30000-39999.
func IsParameterisedReplaceable(kind int) bool {
	return kind >= 30000 && kind < 40000
}

// IsEphemeral returns true for Kind 20000-29999.
func IsEphemeral(kind int) bool {
	return kind >= 20000 && kind < 30000
}

// IsReplaceableOrParameterised returns true if the event kind uses replacement semantics.
func IsReplaceableOrParameterised(kind int) bool {
	return IsReplaceable(kind) || IsParameterisedReplaceable(kind)
}

// HasEqualiserTag checks if the event has an ["app", "Equaliser"] tag (case-insensitive value).
func (e *Event) HasEqualiserTag() bool {
	for _, tag := range e.Tags {
		if len(tag) >= 2 && tag[0] == "app" && strings.EqualFold(tag[1], "equaliser") {
			return true
		}
	}
	return false
}

// MarshalRaw returns the event as raw JSON bytes (for storing in JSONB column).
func (e *Event) MarshalRaw() ([]byte, error) {
	return json.Marshal(e)
}

// ParseEventFromRaw parses an Event from raw JSON bytes.
func ParseEventFromRaw(raw []byte) (*Event, error) {
	var event Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, err
	}
	return &event, nil
}