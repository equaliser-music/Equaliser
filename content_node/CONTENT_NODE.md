# Equaliser Content Node

The content node is the infrastructure that powers an artist's presence on the Equaliser platform. It handles content serving, NOSTR identity, and will eventually manage payments and content processing.

## Architecture

```
content_node/
├── docker-compose.yml      # Orchestrates all services
├── nostr-relay/            # NOSTR relay configuration
│   └── config.toml
├── orchestrator/           # Artist admin tools & API (future)
│   ├── onboarding.html     # Artist onboarding wizard
│   └── ONBOARDING.md       # Onboarding documentation
├── web/                    # Nginx web server configuration
│   └── nginx.conf
└── demo_accounts/          # Local storage for demo artist keys (gitignored)
```

## Services

| Service | Container | Internal Port | Purpose |
|---------|-----------|---------------|---------|
| `web` | nginx:alpine | 80 | Serves static files, routes requests |
| `nostr-relay` | nostr-rs-relay | 8080 | NOSTR event storage and relay |

## URL Routing

| Path | Destination | Description |
|------|-------------|-------------|
| `/` | `client/` | Fan-facing web app (landing page, artist pages) |
| `/artist.html` | `client/artist.html` | Artist profile page (accepts `?npub=` parameter) |
| `/admin` | `orchestrator/` | Artist admin tools (onboarding, dashboard) |
| `/relay` | nostr-relay:8080 | WebSocket proxy to NOSTR relay |
| `/api` | orchestrator:8000 | API endpoints (future) |
| `/health` | nginx | Health check endpoint |

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Port 80 available

### Start All Services

```bash
cd content_node
docker-compose up -d
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f web
docker-compose logs -f nostr-relay
```

### Stop All Services

```bash
docker-compose down
```

### Check Status

```bash
docker-compose ps
```

## Accessing the Platform

Once running:

| URL | Description |
|-----|-------------|
| http://localhost | Landing page (under construction) |
| http://localhost/artist.html?npub=... | Artist profile page |
| http://localhost/admin/onboarding.html | Artist onboarding wizard |
| ws://localhost/relay | NOSTR relay WebSocket |
| http://localhost/health | Health check |

## Client Application

The client is a fan-facing web application served from the `../client/` directory.

### Pages

| File | Description |
|------|-------------|
| `index.html` | Landing page with "under construction" message |
| `artist.html` | Artist profile page, fetches data from NOSTR relays |

### Relay Configuration

The client automatically detects the environment:
- **Development** (localhost): Uses the local relay at `ws://localhost/relay`
- **Production**: Uses public NOSTR relays (relay.damus.io, nos.lol, relay.nostr.band)

This keeps development isolated while production remains decentralised.

## Artist Onboarding

The onboarding wizard at `/admin/onboarding.html` allows artists to:

1. **Create a new NOSTR identity** - Generates cryptographic keypairs in the browser
2. **Load from backup** - Import an existing `equaliser-backup-*.json` file
3. **Login with nsec** - Enter an existing private key manually
4. **Configure profile** - Set name, bio, location, and genres
5. **Publish to relays** - Broadcast profile to selected NOSTR relays with real-time status

### Features

- Keys are generated client-side and never sent to any server
- Real-time publishing status shows connection/publish progress for each relay
- Only proceeds to success if at least one relay publishes successfully
- Backup file download includes keys and profile data

See [ONBOARDING.md](./orchestrator/ONBOARDING.md) for detailed documentation.

## NOSTR Relay

The content node runs a [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay) instance for storing and serving NOSTR events.

### Configuration

Edit `nostr-relay/config.toml` to customize:

- `[info]` - Relay metadata (name, description)
- `[database]` - Storage settings
- `[network]` - Port and address
- `[limits]` - Connection and message limits

### Supported NIPs

1, 2, 9, 11, 12, 15, 16, 20, 22, 26, 28, 33, 40, 42

### Data Persistence

Relay data is stored in a Docker volume `nostr-data`. To backup:

```bash
docker-compose stop
docker run --rm -v equaliser-1_nostr-data:/data -v $(pwd):/backup alpine tar czf /backup/nostr-backup.tar.gz /data
docker-compose start
```

## Nginx Web Server

The nginx container serves static files and proxies requests to backend services.

### Static File Mounts

| Container Path | Host Path | Purpose |
|----------------|-----------|---------|
| `/usr/share/nginx/html/client` | `../client/` | Fan-facing app |
| `/usr/share/nginx/html/admin` | `./orchestrator/` | Admin tools |

### WebSocket Support

The `/relay` path is configured for WebSocket connections to the NOSTR relay with:
- HTTP/1.1 upgrade headers
- Path rewriting (strips `/relay` prefix)
- 24-hour read timeout for long-lived connections

### Compression

Gzip compression is enabled for text, CSS, JSON, and JavaScript files.

## Future Components

### Orchestrator API (Planned)

Python/FastAPI service that will handle:
- Content upload and processing
- HLS encoding with FFmpeg
- IPFS integration
- Strike payment webhooks
- Decryption key distribution

### IPFS Node (Planned)

Kubo IPFS daemon for:
- Encrypted content storage
- Content addressing (CIDs)
- Distributed content delivery

## Development

### Rebuilding After Changes

```bash
# Restart nginx to pick up config changes
docker-compose restart web

# Rebuild everything
docker-compose down && docker-compose up -d
```

### Viewing Nginx Access Logs

```bash
docker-compose exec web cat /var/log/nginx/access.log
```

### Testing the Relay

```bash
# Check relay info (NIP-11)
curl -H "Accept: application/nostr+json" http://localhost/relay
```

## Troubleshooting

### Port 80 Already in Use

Check what's using port 80:
```bash
lsof -i :80
```

Change the port in `docker-compose.yml`:
```yaml
ports:
  - "8080:80"  # Use port 8080 instead
```

### Relay Not Starting

Check relay logs:
```bash
docker-compose logs nostr-relay
```

Common issues:
- Invalid config.toml syntax
- Database corruption (delete volume and restart)

### WebSocket Connection Failed

If you get "Connection failed" errors when connecting to `ws://localhost/relay`:

1. Check the relay is running: `docker-compose ps`
2. Verify nginx config has trailing slash on proxy_pass: `proxy_pass http://nostr-relay:8080/;`
3. Restart nginx: `docker-compose restart web`
4. Test relay directly: `curl -H "Accept: application/nostr+json" http://localhost/relay`

### Static Files Not Loading

Verify mounts are correct:
```bash
docker-compose exec web ls -la /usr/share/nginx/html/client
docker-compose exec web ls -la /usr/share/nginx/html/admin
```

## References

- [Technical Specification](../Technical%20Specification.md)
- [Project Rules](../PROJECT_RULES.md)
- [NOSTR Protocol](https://github.com/nostr-protocol/nostr)
- [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay)
- [Onboarding Documentation](./orchestrator/ONBOARDING.md)
