package storage

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a new PostgreSQL connection pool.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}

	config.MaxConns = 20
	config.MinConns = 2
	config.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	// Verify connection
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	log.Println("Connected to PostgreSQL")
	return pool, nil
}

// RunMigrations executes SQL migration files from the migrations directory.
// It uses a schema_version table to track which migrations have been applied.
func RunMigrations(ctx context.Context, pool *pgxpool.Pool, migrationsDir string) error {
	// Create schema_version table if it doesn't exist
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			applied_at TIMESTAMPTZ DEFAULT NOW(),
			filename TEXT NOT NULL
		)
	`)
	if err != nil {
		return fmt.Errorf("create schema_version table: %w", err)
	}

	// Get current version
	var currentVersion int
	err = pool.QueryRow(ctx, "SELECT COALESCE(MAX(version), 0) FROM schema_version").Scan(&currentVersion)
	if err != nil {
		return fmt.Errorf("get current version: %w", err)
	}

	// Read migration files
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations directory: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}

		// Extract version number from filename (e.g., 001_initial.sql -> 1)
		var version int
		_, err := fmt.Sscanf(entry.Name(), "%d_", &version)
		if err != nil {
			log.Printf("Skipping migration file with invalid name: %s", entry.Name())
			continue
		}

		if version <= currentVersion {
			continue
		}

		// Read and execute migration
		path := filepath.Join(migrationsDir, entry.Name())
		sql, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}

		log.Printf("Applying migration %s...", entry.Name())

		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin transaction for migration %s: %w", entry.Name(), err)
		}

		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("execute migration %s: %w", entry.Name(), err)
		}

		if _, err := tx.Exec(ctx, "INSERT INTO schema_version (version, filename) VALUES ($1, $2)", version, entry.Name()); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", entry.Name(), err)
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", entry.Name(), err)
		}

		log.Printf("Applied migration %s", entry.Name())
	}

	return nil
}
