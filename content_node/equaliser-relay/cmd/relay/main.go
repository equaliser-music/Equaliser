package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"equaliser-relay/internal/api"
	"equaliser-relay/internal/config"
	"equaliser-relay/internal/relay"
	"equaliser-relay/internal/storage"
	"equaliser-relay/internal/syncer"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting Equaliser Relay...")

	// Load configuration
	cfg := config.Load()
	log.Printf("Config: name=%s, policy=%s, ws_port=%d, rest_port=%d", cfg.RelayName, cfg.EventPolicy, cfg.WSPort, cfg.RESTAPIPort)

	// Connect to PostgreSQL
	ctx := context.Background()
	pool, err := storage.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Run migrations
	migrationsDir := "/migrations"
	if _, err := os.Stat(migrationsDir); os.IsNotExist(err) {
		// Fall back to local path for development
		migrationsDir = "migrations"
	}
	if err := storage.RunMigrations(ctx, pool, migrationsDir); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Bootstrap node operators from env (idempotent — ON CONFLICT DO NOTHING)
	if len(cfg.OperatorPubkeys) > 0 {
		if err := storage.NewUserStore(pool).BootstrapOperators(ctx, cfg.OperatorPubkeys); err != nil {
			log.Printf("Warning: failed to bootstrap operators: %v", err)
		}
	}

	// Create services
	eventStore := storage.NewEventStore(pool)
	userStore := storage.NewUserStore(pool)
	adminStore := storage.NewAdminStore(pool)

	// First-run setup: if no operators yet, generate a setup token (printed loudly)
	// so the first visitor at /admin/setup.html can claim themselves as operator.
	// Token is also written to /data/setup-token.txt for shell-access discovery.
	manageSetupToken(ctx, adminStore)
	denormParser := storage.NewDenormParser(pool, cfg)
	subMgr := relay.NewSubscriptionManager()
	handler := relay.NewHandler(eventStore, denormParser, subMgr, cfg)

	// Start peer syncer (Equaliser peers and/or standard relays)
	peerStore := storage.NewPeerStore(pool)
	var peerSyncer *syncer.Syncer
	if len(cfg.PeerRelays) > 0 || len(cfg.StandardRelays) > 0 {
		peerSyncer = syncer.New(handler, subMgr, peerStore, userStore, cfg)
		peerSyncer.Start(ctx)
		log.Printf("Peer syncer started: %d Equaliser peer(s), %d standard relay(s)", len(cfg.PeerRelays), len(cfg.StandardRelays))
	} else {
		log.Println("No peer relays configured, syncer disabled")
	}

	// Wire up external reply checking (triggered when Equaliser-tagged replies are stored)
	if peerSyncer != nil {
		handler.OnEventStored = peerSyncer.OnEventStored
	}

	// Set up WebSocket server
	wsMux := http.NewServeMux()
	wsMux.Handle("/", handler)

	wsServer := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.WSPort),
		Handler:      wsMux,
		ReadTimeout:  0, // No read timeout for WebSocket
		WriteTimeout: 0, // No write timeout for WebSocket
		IdleTimeout:  120 * time.Second,
	}

	// Set up REST API server
	delegationStore := storage.NewDelegationStore(pool)
	apiServer := api.NewServer(userStore, eventStore, adminStore, peerStore, delegationStore)
	restServer := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.RESTAPIPort),
		Handler:      apiServer.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("Received signal %s, shutting down...", sig)

		// Stop syncer first (closes peer WebSocket connections)
		if peerSyncer != nil {
			peerSyncer.Stop()
		}

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := wsServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("WS shutdown error: %v", err)
		}
		if err := restServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("REST shutdown error: %v", err)
		}
	}()

	// Start REST API server in background
	go func() {
		log.Printf("REST API listening on :%d", cfg.RESTAPIPort)
		if err := restServer.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("REST server error: %v", err)
		}
	}()

	log.Printf("Equaliser Relay WebSocket listening on :%d", cfg.WSPort)
	if err := wsServer.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("WS server error: %v", err)
	}

	log.Println("Equaliser Relay stopped")
}

// manageSetupToken handles the first-run operator setup token lifecycle.
//
// If the node has no operators yet, generate a fresh 32-byte hex setup token,
// store it in setup_state, write it to /data/setup-token.txt (mode 0600),
// and print a banner to stdout so a human running `docker logs` can find it.
//
// If operators already exist, ensure no stale setup-token file remains on disk
// and clear setup_state.setup_token if set.
//
// Token rotates on every boot when no operator exists — an unclaimed node
// doesn't keep a permanent shared secret across restarts.
func manageSetupToken(ctx context.Context, store *storage.AdminStore) {
	hasOps, err := store.HasOperators(ctx)
	if err != nil {
		log.Printf("Warning: setup-token check failed: %v", err)
		return
	}

	const tokenFile = "/data/setup-token.txt"

	if hasOps {
		// Cleanup any stale state
		_ = store.ClearSetupToken(ctx)
		_ = os.Remove(tokenFile)
		return
	}

	// No operators — generate a token, log + persist
	token, err := store.GenerateSetupToken(ctx)
	if err != nil {
		log.Printf("ERROR: failed to generate setup token: %v", err)
		return
	}

	// Write to disk for shell-access discovery (best-effort; non-fatal if write fails)
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0o700); err == nil {
		if err := os.WriteFile(tokenFile, []byte(token+"\n"), 0o600); err != nil {
			log.Printf("Warning: could not write %s: %v", tokenFile, err)
		}
	} else {
		log.Printf("Warning: could not create %s: %v (token only available in logs)", filepath.Dir(tokenFile), err)
	}

	// Loud banner — easy to spot in `docker logs`
	log.Println("")
	log.Println("============================================================")
	log.Println(" NO OPERATOR CONFIGURED. To claim this node:")
	log.Println("   1. Visit /admin/setup.html in your browser")
	log.Println("   2. Enter setup token: " + token)
	log.Println("   3. Sign in with your nsec or NIP-07 extension")
	log.Println(" Token is also at " + tokenFile + " inside the relay container.")
	log.Println(" Token rotates on every restart until claimed.")
	log.Println("============================================================")
	log.Println("")
}
