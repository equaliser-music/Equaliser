package syncer

import (
	"context"
	"log"
	"time"

	"equaliser-relay/internal/nostr"

	"github.com/coder/websocket"
)

// OnEventStored is the callback wired to Handler.OnEventStored.
// When an Equaliser-tagged Kind 1 reply is stored, it checks standard relays
// for other (non-Equaliser) replies to the same thread root and records the
// count in thread_external_refs.
func (s *Syncer) OnEventStored(event *nostr.Event) {
	// Only check for Equaliser-tagged Kind 1 replies that reference a parent event
	if event.Kind != 1 || !event.HasEqualiserTag() {
		return
	}

	// Find the root event ID (NIP-10: first "e" tag with "root" marker, or just the first "e" tag)
	rootID := findRootEventID(event)
	if rootID == "" {
		return // Not a reply, nothing to check
	}

	// No standard relays configured — nothing to query
	if len(s.cfg.StandardRelays) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	s.checkExternalReplies(ctx, rootID)
}

// checkExternalReplies queries standard relays for replies to a thread root
// and updates the external reply count in thread_external_refs.
func (s *Syncer) checkExternalReplies(ctx context.Context, rootEventID string) {
	totalExternal := 0

	for _, relayURL := range s.cfg.StandardRelays {
		count, err := s.countExternalRepliesFromRelay(ctx, relayURL, rootEventID)
		if err != nil {
			log.Printf("Syncer: external reply check failed for %s on %s: %v", rootEventID, relayURL, err)
			continue
		}
		if count > totalExternal {
			totalExternal = count // Take the highest count from any relay
		}
	}

	if err := s.userStore.UpsertThreadExternalRefs(ctx, rootEventID, totalExternal); err != nil {
		log.Printf("Syncer: failed to update external refs for %s: %v", rootEventID, err)
	}
}

// countExternalRepliesFromRelay connects to a standard relay, queries for replies
// to the given root event, and counts how many are NOT already stored locally.
func (s *Syncer) countExternalRepliesFromRelay(ctx context.Context, relayURL string, rootEventID string) (int, error) {
	dialCtx, dialCancel := context.WithTimeout(ctx, 10*time.Second)
	ws, _, err := websocket.Dial(dialCtx, relayURL, nil)
	dialCancel()
	if err != nil {
		return 0, err
	}
	defer ws.CloseNow()

	ws.SetReadLimit(int64(s.cfg.MaxMessageLength))

	// Subscribe for Kind 1 events that reference this root via #e tag
	subID := "ext-check"
	filter := nostr.Filter{
		Kinds: []int{1},
		Tags:  map[string][]string{"e": {rootEventID}},
	}

	reqMsg, err := nostr.BuildReqMessage(subID, filter)
	if err != nil {
		return 0, err
	}
	if err := ws.Write(ctx, websocket.MessageText, reqMsg); err != nil {
		return 0, err
	}

	// Read replies until EOSE
	externalCount := 0
	for {
		readCtx, readCancel := context.WithTimeout(ctx, 10*time.Second)
		_, data, err := ws.Read(readCtx)
		readCancel()
		if err != nil {
			break
		}

		msgType, _, parseErr := nostr.ParseMessage(data)
		if parseErr != nil {
			continue
		}

		switch msgType {
		case "EVENT":
			_, evt, evtErr := nostr.ParseRelayEventMessage(data)
			if evtErr != nil {
				continue
			}
			// Check if we already have this event locally
			exists, existErr := s.handler.Store().EventExists(ctx, evt.ID)
			if existErr != nil || !exists {
				externalCount++
			}
		case "EOSE":
			// Done — close subscription and return
			closeMsg, _ := nostr.BuildCloseMessage(subID)
			ws.Write(ctx, websocket.MessageText, closeMsg)
			ws.Close(websocket.StatusNormalClosure, "done")
			return externalCount, nil
		}
	}

	return externalCount, nil
}

// findRootEventID extracts the root event ID from NIP-10 "e" tags.
// Looks for a tag with "root" marker first, then falls back to the first "e" tag.
func findRootEventID(event *nostr.Event) string {
	var firstE string
	for _, tag := range event.Tags {
		if len(tag) < 2 || tag[0] != "e" {
			continue
		}
		if firstE == "" {
			firstE = tag[1]
		}
		// NIP-10: ["e", <id>, <relay>, "root"]
		if len(tag) >= 4 && tag[3] == "root" {
			return tag[1]
		}
	}
	return firstE
}
