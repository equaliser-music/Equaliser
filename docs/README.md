# Equaliser NOSTR Relay

A Docker-based NOSTR relay for the Equaliser content node using [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay).

## Quick Start

```bash
# Build and start the relay
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the relay
docker-compose down
```

## Configuration

Edit `config.toml` to customize relay settings:

- **info.name** - Your relay's display name
- **info.description** - Relay description
- **info.pubkey** - Your NOSTR public key (hex format)
- **info.contact** - Contact email or URL
- **network.port** - WebSocket port (default: 8080)

## Connecting

Once running, connect to your relay at:

```
ws://localhost:8080
```

For production, use a reverse proxy (nginx/caddy) with TLS:

```
wss://your-domain.com
```

## Data Persistence

The SQLite database is stored in a Docker volume `nostr-data`. To backup:

```bash
# Simple backup
docker-compose exec nostr-relay sqlite3 /app/data/nostr.db ".backup /app/data/backup.db"

# Or stop and copy
docker-compose stop
docker cp equaliser-nostr-relay:/app/data/nostr.db ./nostr-backup.db
docker-compose start
```

## Useful Commands

```bash
# Rebuild after Dockerfile changes
docker-compose up -d --build

# Check relay info (NIP-11)
curl -H "Accept: application/nostr+json" http://localhost:8080

# View resource usage
docker stats equaliser-nostr-relay

# Access SQLite database
docker-compose exec nostr-relay sqlite3 /app/data/nostr.db
```

## Advanced Configuration

### Private Relay

Uncomment and edit in `config.toml`:

```toml
[authorization]
pubkey_whitelist = ["your-hex-pubkey", "another-hex-pubkey"]
```

### Paid Relay

```toml
[pay_to_relay]
enabled = true
admission_cost = 1000  # sats for admission
cost_per_event = 1     # sats per event
```

### NIP-42 Authentication

```toml
[authorization]
nip42_auth = true
```

## NIP Support

nostr-rs-relay supports NIPs: 1, 2, 4, 9, 11, 12, 15, 16, 20, 22, 26, 28, 33, 40, 42
