package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL      string
	WSPort           int
	RelayName        string
	RelayDescription string
	EventPolicy      string // equaliser_only, open, hybrid
	MaxSubscriptions int
	MaxFilters       int
	MaxMessageLength int
	MaxEventTags     int
	PeerRelays       []string // WebSocket URLs of peer relays (from PEER_RELAYS env)
	SyncInterval     int      // seconds between periodic full syncs (from SYNC_INTERVAL env)
}

func Load() *Config {
	cfg := &Config{
		DatabaseURL:      getEnv("DATABASE_URL", ""),
		WSPort:           getEnvInt("WS_PORT", 8080),
		RelayName:        getEnv("RELAY_NAME", "Equaliser Relay"),
		RelayDescription: getEnv("RELAY_DESCRIPTION", "Equaliser content node relay"),
		EventPolicy:      getEnv("EVENT_POLICY", "equaliser_only"),
		MaxSubscriptions: getEnvInt("MAX_SUBSCRIPTIONS", 20),
		MaxFilters:       getEnvInt("MAX_FILTERS", 10),
		MaxMessageLength: getEnvInt("MAX_MESSAGE_LENGTH", 65536),
		MaxEventTags:     getEnvInt("MAX_EVENT_TAGS", 2000),
	}

	// Parse PEER_RELAYS (comma-separated, empty = no syncing)
	if peerRelaysStr := getEnv("PEER_RELAYS", ""); peerRelaysStr != "" {
		for _, url := range strings.Split(peerRelaysStr, ",") {
			url = strings.TrimSpace(url)
			if url != "" {
				cfg.PeerRelays = append(cfg.PeerRelays, url)
			}
		}
	}
	cfg.SyncInterval = getEnvInt("SYNC_INTERVAL", 3600)

	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL environment variable is required")
	}

	switch cfg.EventPolicy {
	case "equaliser_only", "open", "hybrid":
		// valid
	default:
		log.Fatalf("Invalid EVENT_POLICY: %s (must be equaliser_only, open, or hybrid)", cfg.EventPolicy)
	}

	return cfg
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if val := os.Getenv(key); val != "" {
		n, err := strconv.Atoi(val)
		if err != nil {
			log.Fatalf("Invalid integer for %s: %s", key, val)
		}
		return n
	}
	return fallback
}
