package relay

import (
	"encoding/json"
	"log"
	"sync"

	"equaliser-relay/internal/nostr"
)

// Subscription represents a single NIP-01 subscription from a client connection.
type Subscription struct {
	ID      string
	Filters []nostr.Filter
	ConnID  string // identifies the connection this subscription belongs to
}

// Connection represents a WebSocket connection with a write channel.
type Connection struct {
	ID      string
	WriteCh chan []byte
	Done    chan struct{}
}

// SubscriptionManager manages all active subscriptions across all connections.
type SubscriptionManager struct {
	mu            sync.RWMutex
	subscriptions map[string]*Subscription    // keyed by connID:subID
	connections   map[string]*Connection       // keyed by connID
}

// NewSubscriptionManager creates a new SubscriptionManager.
func NewSubscriptionManager() *SubscriptionManager {
	return &SubscriptionManager{
		subscriptions: make(map[string]*Subscription),
		connections:   make(map[string]*Connection),
	}
}

// RegisterConnection adds a new connection.
func (sm *SubscriptionManager) RegisterConnection(conn *Connection) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.connections[conn.ID] = conn
}

// UnregisterConnection removes a connection and all its subscriptions.
func (sm *SubscriptionManager) UnregisterConnection(connID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Remove all subscriptions for this connection
	for key, sub := range sm.subscriptions {
		if sub.ConnID == connID {
			delete(sm.subscriptions, key)
		}
	}

	delete(sm.connections, connID)
}

// AddSubscription adds or replaces a subscription for a connection.
func (sm *SubscriptionManager) AddSubscription(connID, subID string, filters []nostr.Filter) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	key := connID + ":" + subID
	sm.subscriptions[key] = &Subscription{
		ID:      subID,
		Filters: filters,
		ConnID:  connID,
	}
}

// RemoveSubscription removes a specific subscription.
func (sm *SubscriptionManager) RemoveSubscription(connID, subID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	key := connID + ":" + subID
	delete(sm.subscriptions, key)
}

// CountSubscriptions returns the number of subscriptions for a connection.
func (sm *SubscriptionManager) CountSubscriptions(connID string) int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	count := 0
	for _, sub := range sm.subscriptions {
		if sub.ConnID == connID {
			count++
		}
	}
	return count
}

// NotifyNewEvent checks all active subscriptions and sends the event to matching ones.
// This is called after a new event is stored.
func (sm *SubscriptionManager) NotifyNewEvent(event *nostr.Event, rawEvent json.RawMessage, sourceConnID string) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	for _, sub := range sm.subscriptions {
		// Don't notify the sender of their own event
		if sub.ConnID == sourceConnID {
			continue
		}

		// Check if event matches any of the subscription's filters
		matched := false
		for _, f := range sub.Filters {
			if f.MatchesEvent(event) {
				matched = true
				break
			}
		}

		if !matched {
			continue
		}

		// Build the EVENT message
		msg, err := nostr.BuildEventMessage(sub.ID, rawEvent)
		if err != nil {
			log.Printf("Failed to build event message for sub %s: %v", sub.ID, err)
			continue
		}

		// Send to the connection's write channel (non-blocking)
		conn, ok := sm.connections[sub.ConnID]
		if !ok {
			continue
		}

		select {
		case conn.WriteCh <- msg:
		default:
			log.Printf("Write channel full for connection %s, dropping event notification", sub.ConnID)
		}
	}
}
