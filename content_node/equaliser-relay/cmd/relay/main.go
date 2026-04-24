package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	apiServer := api.NewServer(userStore, eventStore)
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
