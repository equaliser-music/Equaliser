# NOSTR Relay for Equaliser Content Node

This directory contains a Docker-based NOSTR relay implementation using [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay), a Rust-based relay with SQLite storage.

## What's Here

```
nostr-relay/
├── Dockerfile          # Multi-stage build for nostr-rs-relay
├── docker-compose.yml  # Container orchestration with persistent storage
├── config.toml         # Relay configuration (NIP-11 info, limits, auth)
├── README.md           # Quick reference and commands
└── NOSTR.md            # This file
```

### File Descriptions

**Dockerfile**
- Uses a multi-stage build: Rust builder → slim Debian runtime
- Compiles nostr-rs-relay from crates.io
- Runs as non-root `nostr` user for security
- Final image is ~100MB

**docker-compose.yml**
- Exposes port 8080 for WebSocket connections
- Creates a named volume `nostr-data` for SQLite database persistence
- Mounts `config.toml` as read-only for easy config updates
- Includes health check for container monitoring

**config.toml**
- `[info]` - NIP-11 relay metadata (name, description, operator pubkey)
- `[database]` - SQLite data directory
- `[network]` - Bind address and port
- `[limits]` - Connection limits, message sizes, rate limiting
- `[authorization]` - Pubkey whitelist, NIP-42 auth options
- `[pay_to_relay]` - Lightning payment options (disabled by default)

## How to Run

### Prerequisites

- Docker and Docker Compose installed
- Port 8080 available (or change in config)

### Start the Relay

```bash
cd content_node/nostr-relay

# Build and start (first run will take a few minutes to compile)
docker-compose up -d

# Watch the build and startup logs
docker-compose logs -f
```

### Verify It's Running

```bash
# Check container status
docker-compose ps

# Query NIP-11 relay info
curl -H "Accept: application/nostr+json" http://localhost:8080
```

You should see JSON with the relay name "Equaliser Content Node Relay".

### Connect a Client

Use any NOSTR client and add the relay:

```
ws://localhost:8080
```

For testing, you can use:
- [Damus](https://damus.io) (iOS)
- [Amethyst](https://github.com/vitorpamplona/amethyst) (Android)
- [Snort](https://snort.social) (Web)
- [Nostril](https://github.com/jb55/nostril) (CLI)

### Stop the Relay

```bash
docker-compose down
```

Data persists in the Docker volume. To remove data:

```bash
docker-compose down -v
```

## Configuration

### Update Relay Info

Edit `config.toml` and update the `[info]` section:

```toml
[info]
name = "Your Relay Name"
description = "Your description"
pubkey = "your-hex-pubkey"
contact = "admin@example.com"
```

Then restart:

```bash
docker-compose restart
```

### Make it a Private Relay

Only allow specific pubkeys to post:

```toml
[authorization]
pubkey_whitelist = [
    "hexkey1...",
    "hexkey2..."
]
```

### Enable NIP-42 Authentication

Require clients to prove identity:

```toml
[authorization]
nip42_auth = true
```

### Change the Port

Edit both files:

**config.toml:**
```toml
[network]
port = 7777
```

**docker-compose.yml:**
```yaml
ports:
  - "7777:7777"
```

## App-Tag Filtering & Spam Management

Content node relays are **public** (open read + write) to support decentralisation. Spam defence operates at the application layer using the `["app", "equaliser"]` tag:

- **Tagging**: All events created through Equaliser are tagged with `["app", "equaliser"]` before signing
- **Filtering**: UI feeds only display events with this tag — untagged events are invisible to users
- **Cleanup**: `cleanup-relay.sh` periodically removes untagged events from non-protected pubkeys

This approach keeps relays public for cross-node discovery and fan interaction while creating a clean, curated Equaliser experience in the UI. The relay accumulates some junk between cleanups, but the UI never shows it.

See [SOCIAL.md](../docs/SOCIAL.md) for the full two-layer architecture (Equaliser Network vs Wider NOSTR).

## Production Deployment

For production, you'll need:

1. **TLS termination** - Use nginx or Caddy as a reverse proxy:

```nginx
# nginx example
location / {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

2. **Domain name** - Point DNS to your server

3. **Firewall** - Only expose 443 (HTTPS/WSS), not 8080 directly

Your relay URL becomes: `wss://your-domain.com`

## Backup & Restore

### Backup

```bash
# While running (SQLite supports this)
docker-compose exec nostr-relay sqlite3 /app/data/nostr.db ".backup /app/data/backup.db"
docker cp equaliser-nostr-relay:/app/data/backup.db ./nostr-backup.db
```

### Restore

```bash
docker-compose down
docker cp ./nostr-backup.db equaliser-nostr-relay:/app/data/nostr.db
docker-compose up -d
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs

# Rebuild from scratch
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Port already in use

Change the port in `docker-compose.yml`:

```yaml
ports:
  - "9090:8080"  # Use 9090 on host
```

### Database issues

Reset the database:

```bash
docker-compose down -v
docker-compose up -d
```

## Why nostr-rs-relay?

We chose nostr-rs-relay over alternatives like strfry because:

- **Simpler setup** - Single binary, straightforward config
- **Lower resource usage** - SQLite is memory-efficient
- **Easy backups** - SQLite is a single file
- **Good NIP support** - Covers all common NIPs
- **Active maintenance** - Regular updates and fixes

For high-traffic production relays needing maximum throughput, consider [strfry](https://github.com/hoytech/strfry) instead.
