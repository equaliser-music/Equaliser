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

	"equaliser-relay/internal/config"
	"equaliser-relay/internal/relay"
	"equaliser-relay/internal/storage"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting Equaliser Relay...")

	// Load configuration
	cfg := config.Load()
	log.Printf("Config: name=%s, policy=%s, port=%d", cfg.RelayName, cfg.EventPolicy, cfg.WSPort)

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

	// Create services
	eventStore := storage.NewEventStore(pool)
	denormParser := storage.NewDenormParser()
	subMgr := relay.NewSubscriptionManager()
	handler := relay.NewHandler(eventStore, denormParser, subMgr, cfg)

	// Set up HTTP server
	mux := http.NewServeMux()
	mux.Handle("/", handler)

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.WSPort),
		Handler:      mux,
		ReadTimeout:  0, // No read timeout for WebSocket
		WriteTimeout: 0, // No write timeout for WebSocket
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("Received signal %s, shutting down...", sig)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("Shutdown error: %v", err)
		}
	}()

	log.Printf("Equaliser Relay listening on :%d", cfg.WSPort)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Equaliser Relay stopped")
}
