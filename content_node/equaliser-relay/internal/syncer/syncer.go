package syncer

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"equaliser-relay/internal/config"
	"equaliser-relay/internal/nostr"
	"equaliser-relay/internal/relay"
	"equaliser-relay/internal/storage"

	"github.com/coder/websocket"
)

// Syncer manages WebSocket connections to peer relays for inbound syncing
// and outbound event forwarding.
type Syncer struct {
	handler   *relay.Handler
	subMgr    *relay.SubscriptionManager
	peerStore *storage.PeerStore
	cfg       *config.Config

	// Active peer connections for outbound forwarding
	peerConns   map[string]*websocket.Conn
	peerConnsMu sync.RWMutex

	// Outbound connection registered in SubscriptionManager
	outboundConn *relay.Connection
	connID       string

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New creates a new Syncer.
func New(handler *relay.Handler, subMgr *relay.SubscriptionManager, peerStore *storage.PeerStore, cfg *config.Config) *Syncer {
	return &Syncer{
		handler:   handler,
		subMgr:    subMgr,
		peerStore: peerStore,
		cfg:       cfg,
		peerConns: make(map[string]*websocket.Conn),
		connID:    "syncer-outbound",
	}
}

// Start begins the syncer. It seeds configured peers into the database,
// registers for outbound forwarding, and launches per-peer sync goroutines.
func (s *Syncer) Start(ctx context.Context) {
	ctx, s.cancel = context.WithCancel(ctx)

	// Seed peer_relays table with configured URLs
	for _, url := range s.cfg.PeerRelays {
		if err := s.peerStore.UpsertPeer(ctx, url, false); err != nil {
			log.Printf("Syncer: failed to seed peer %s: %v", url, err)
		}
	}

	// Register as a SubscriptionManager connection for outbound forwarding.
	// When local events are stored, NotifyNewEvent delivers them to our WriteCh.
	s.outboundConn = &relay.Connection{
		ID:      s.connID,
		WriteCh: make(chan []byte, 512),
		Done:    make(chan struct{}),
	}
	s.subMgr.RegisterConnection(s.outboundConn)

	// Subscribe to all Equaliser events for outbound forwarding
	s.subMgr.AddSubscription(s.connID, "outbound-eq", []nostr.Filter{
		{Tags: map[string][]string{"app": {"Equaliser", "equaliser"}}},
	})

	// Start outbound forwarder
	s.wg.Add(1)
	go s.outboundForwarder(ctx)

	// Start one goroutine per peer relay
	for _, url := range s.cfg.PeerRelays {
		s.wg.Add(1)
		go s.peerLoop(ctx, url)
	}
}

// Stop cancels all peer connections and waits for goroutines to finish.
func (s *Syncer) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.wg.Wait()
	s.subMgr.UnregisterConnection(s.connID)
	log.Println("Syncer: stopped")
}

// outboundForwarder reads events from the SubscriptionManager and forwards
// them to all connected peer relays.
func (s *Syncer) outboundForwarder(ctx context.Context) {
	defer s.wg.Done()

	for {
		select {
		case msg, ok := <-s.outboundConn.WriteCh:
			if !ok {
				return
			}
			s.forwardToAllPeers(ctx, msg)
		case <-s.outboundConn.Done:
			return
		case <-ctx.Done():
			return
		}
	}
}

// forwardToAllPeers extracts the event from a relay EVENT message and sends
// it to all connected peer relays as a client EVENT message.
func (s *Syncer) forwardToAllPeers(ctx context.Context, relayEventMsg []byte) {
	// relayEventMsg is ["EVENT", subID, event] — extract the event
	_, event, err := nostr.ParseRelayEventMessage(relayEventMsg)
	if err != nil {
		log.Printf("Syncer: failed to parse outbound event: %v", err)
		return
	}

	clientMsg, err := nostr.BuildClientEventMessage(event)
	if err != nil {
		log.Printf("Syncer: failed to build client event message: %v", err)
		return
	}

	s.peerConnsMu.RLock()
	defer s.peerConnsMu.RUnlock()

	for url, ws := range s.peerConns {
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := ws.Write(writeCtx, websocket.MessageText, clientMsg)
		cancel()
		if err != nil {
			log.Printf("Syncer: failed to forward event to %s: %v", url, err)
		}
	}
}

// peerLoop manages the connection lifecycle for a single peer relay.
// It reconnects with exponential backoff on failure.
func (s *Syncer) peerLoop(ctx context.Context, url string) {
	defer s.wg.Done()

	bo := newBackoff(5*time.Second, 5*time.Minute)

	for {
		select {
		case <-ctx.Done():
			s.peerStore.UpdateDisconnected(context.Background(), url)
			return
		default:
		}

		err := s.connectAndSync(ctx, url, bo)
		if err != nil {
			if ctx.Err() != nil {
				s.peerStore.UpdateDisconnected(context.Background(), url)
				return
			}
			log.Printf("Syncer: peer %s disconnected: %v", url, err)
			s.peerStore.UpdateError(context.Background(), url, err.Error())
		}

		delay := bo.next()
		log.Printf("Syncer: reconnecting to %s in %v", url, delay)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			s.peerStore.UpdateDisconnected(context.Background(), url)
			return
		}
	}
}

// connectAndSync establishes a WebSocket connection to a peer relay,
// subscribes to Equaliser events, and processes inbound messages.
func (s *Syncer) connectAndSync(ctx context.Context, url string, bo *backoff) error {
	// Connect via WebSocket
	dialCtx, dialCancel := context.WithTimeout(ctx, 30*time.Second)
	ws, _, err := websocket.Dial(dialCtx, url, nil)
	dialCancel()
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer ws.CloseNow()

	// Set read limit to match our max message length
	ws.SetReadLimit(int64(s.cfg.MaxMessageLength))

	// Update peer status
	s.peerStore.UpdateConnected(ctx, url)
	bo.reset()

	log.Printf("Syncer: connected to %s", url)

	// Register this peer for outbound forwarding
	s.peerConnsMu.Lock()
	s.peerConns[url] = ws
	s.peerConnsMu.Unlock()
	defer func() {
		s.peerConnsMu.Lock()
		delete(s.peerConns, url)
		s.peerConnsMu.Unlock()
		s.peerStore.UpdateDisconnected(context.Background(), url)
	}()

	// Build subscription filter with incremental since
	since, _ := s.peerStore.GetLastEventAt(ctx, url)
	filter := nostr.Filter{
		Tags: map[string][]string{"app": {"Equaliser", "equaliser"}},
	}
	if since > 0 {
		filter.Since = &since
	}

	// Send REQ
	subID := "eq-sync"
	reqMsg, err := nostr.BuildReqMessage(subID, filter)
	if err != nil {
		return fmt.Errorf("build REQ: %w", err)
	}
	if err := ws.Write(ctx, websocket.MessageText, reqMsg); err != nil {
		return fmt.Errorf("send REQ: %w", err)
	}

	log.Printf("Syncer: subscribed to %s (since=%d)", url, since)

	// Periodic resync timer
	syncTicker := time.NewTicker(time.Duration(s.cfg.SyncInterval) * time.Second)
	defer syncTicker.Stop()

	// Read loop
	for {
		// Check for periodic resync (non-blocking)
		select {
		case <-syncTicker.C:
			s.sendPeriodicResync(ctx, ws, url, subID)
		case <-ctx.Done():
			ws.Close(websocket.StatusNormalClosure, "shutting down")
			return ctx.Err()
		default:
		}

		// Read with timeout to allow periodic context/resync checks
		readCtx, readCancel := context.WithTimeout(ctx, 30*time.Second)
		_, data, err := ws.Read(readCtx)
		readCancel()

		if err != nil {
			if ctx.Err() != nil {
				ws.Close(websocket.StatusNormalClosure, "shutting down")
				return ctx.Err()
			}
			// Read timeout — loop to check context and resync timer
			if readCtx.Err() == context.DeadlineExceeded {
				continue
			}
			return fmt.Errorf("read: %w", err)
		}

		s.handlePeerMessage(ctx, url, data)
	}
}

// handlePeerMessage dispatches a message received from a peer relay.
func (s *Syncer) handlePeerMessage(ctx context.Context, peerURL string, data []byte) {
	msgType, _, err := nostr.ParseMessage(data)
	if err != nil {
		log.Printf("Syncer: invalid message from %s: %v", peerURL, err)
		return
	}

	switch msgType {
	case "EVENT":
		s.handlePeerEvent(ctx, peerURL, data)
	case "EOSE":
		subID, _ := nostr.ParseEOSEMessage(data)
		log.Printf("Syncer: EOSE from %s (sub=%s) — initial sync complete", peerURL, subID)
	case "OK":
		eventID, accepted, message, _ := nostr.ParseOKMessage(data)
		if !accepted && message != "" && !isExpectedDuplicate(message) {
			log.Printf("Syncer: peer %s rejected event %s: %s", peerURL, eventID, message)
		}
	case "NOTICE":
		message, _ := nostr.ParseNoticeMessage(data)
		log.Printf("Syncer: NOTICE from %s: %s", peerURL, message)
	}
}

// handlePeerEvent processes an EVENT message from a peer relay.
func (s *Syncer) handlePeerEvent(ctx context.Context, peerURL string, data []byte) {
	_, event, err := nostr.ParseRelayEventMessage(data)
	if err != nil {
		log.Printf("Syncer: invalid EVENT from %s: %v", peerURL, err)
		return
	}

	sourceID := "syncer-peer-" + peerURL
	result := s.handler.ProcessInboundEvent(ctx, event, sourceID, peerURL)

	if result.Stored {
		s.peerStore.RecordEvent(ctx, peerURL, event.CreatedAt)
	}
}

// sendPeriodicResync closes the current subscription and opens a new one
// with an updated since timestamp.
func (s *Syncer) sendPeriodicResync(ctx context.Context, ws *websocket.Conn, url string, subID string) {
	// Close current subscription
	closeMsg, _ := nostr.BuildCloseMessage(subID)
	ws.Write(ctx, websocket.MessageText, closeMsg)

	// Get updated last_event_at
	since, _ := s.peerStore.GetLastEventAt(ctx, url)

	filter := nostr.Filter{
		Tags: map[string][]string{"app": {"Equaliser", "equaliser"}},
	}
	if since > 0 {
		filter.Since = &since
	}

	reqMsg, _ := nostr.BuildReqMessage(subID, filter)
	ws.Write(ctx, websocket.MessageText, reqMsg)

	log.Printf("Syncer: periodic resync to %s (since=%d)", url, since)
}

// isExpectedDuplicate checks if an OK rejection message indicates a normal
// duplicate that does not need to be logged.
func isExpectedDuplicate(message string) bool {
	return len(message) >= 9 && message[:9] == "duplicate"
}

// ExtractRawEventFromRelayMsg extracts the raw event JSON from a relay EVENT
// message without fully parsing the event. Used for efficient forwarding.
func ExtractRawEventFromRelayMsg(msg []byte) (json.RawMessage, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(msg, &arr); err != nil {
		return nil, err
	}
	if len(arr) < 3 {
		return nil, fmt.Errorf("not a relay EVENT message")
	}
	return arr[2], nil
}
