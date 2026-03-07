package relay

// Filter query building is in storage/query.go to avoid circular imports.
// This file provides in-memory filter matching helpers used by the subscription manager.
// The core Filter struct and MatchesEvent method are in nostr/nip01.go.
