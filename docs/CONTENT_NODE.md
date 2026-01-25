# Equaliser Content Node

The content node is the infrastructure that powers an artist's presence on the Equaliser platform. It handles content serving, NOSTR identity, and will eventually manage payments and content processing.

## Architecture

```
content_node/
├── docker-compose.yml      # Orchestrates all services
├── ipfs/                   # IPFS configuration
├── nostr-relay/            # NOSTR relay configuration
│   └── config.toml
├── orchestrator/           # Artist admin tools & API
│   ├── api/                # FastAPI backend
│   │   ├── Dockerfile
│   │   ├── main.py
│   │   ├── routers/        # API endpoints
│   │   └── services/       # HLS, IPFS, NOSTR services
│   ├── login.html          # Login gateway
│   ├── dashboard.html      # Artist home page (default for /admin)
│   ├── onboarding.html     # Artist onboarding wizard
│   ├── profile.html        # Profile editor
│   ├── upload.html         # Track upload interface
│   ├── settings.html       # Relay and account settings
│   └── js/
│       ├── session.js      # Session manager
│       └── admin-sidebar.js # Sidebar component
├── web/                    # Nginx configuration
│   └── nginx.conf
└── demo_accounts/          # Demo artist keys (gitignored)
```

## Services

| Service | Container | Internal Port | Purpose |
|---------|-----------|---------------|---------|
| `ipfs` | ipfs/kubo | 4001, 5001, 8080 | Decentralised content storage |
| `web` | nginx:alpine | 80 | Serves static files, routes requests |
| `nostr-relay` | nostr-rs-relay | 8080 | NOSTR event storage and relay |
| `orchestrator` | custom (Python) | 8000 | Track uploads, HLS encoding, API |

## URL Routing

| Path | Destination | Description |
|------|-------------|-------------|
| `/` | `client/` | Fan-facing web app (landing page, artist pages) |
| `/artist.html` | `client/artist.html` | Artist profile page (accepts `?npub=` parameter) |
| `/admin` | `orchestrator/dashboard.html` | Artist admin home page (requires login) |
| `/relay` | nostr-relay:8080 | WebSocket proxy to NOSTR relay |
| `/ipfs/{CID}` | ipfs:8080 | IPFS gateway for content retrieval |
| `/api` | orchestrator:8000 | Orchestrator API (track uploads, etc.) |
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

## Install Instructions

After starting the containers for the first time, run these commands to set up the required folder structure:

### IPFS Folder Structure

Create the music directory structure on the IPFS node:

```bash
docker exec equaliser-ipfs ipfs files mkdir -p /music/labels
docker exec equaliser-ipfs ipfs files mkdir -p /music/artists
```

Verify the structure was created:

```bash
docker exec equaliser-ipfs ipfs files ls /music
```

Expected output:
```
artists
labels
```

### IPFS CORS Configuration

Enable CORS on the IPFS API to allow browser uploads from the admin pages:

```bash
docker exec equaliser-ipfs ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["http://localhost", "http://127.0.0.1", "*"]'
docker exec equaliser-ipfs ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'
docker exec equaliser-ipfs ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers '["Authorization", "Content-Type"]'
docker restart equaliser-ipfs
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f ipfs
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
| http://localhost/admin | Artist dashboard (redirects to login if not authenticated) |
| http://localhost/admin/login.html | Login gateway (single entry point) |
| http://localhost/admin/onboarding.html | Artist onboarding wizard |
| http://localhost/admin/profile.html | Artist profile editor |
| http://localhost/admin/settings.html | Relay and account settings |
| http://localhost/admin/upload.html | Track upload interface |
| ws://localhost/relay | NOSTR relay WebSocket |
| http://localhost/ipfs/{CID} | IPFS content gateway |
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

## Artist Admin Pages

The admin section provides tools for artists to manage their NOSTR presence.

### Dashboard (`/admin` or `/admin/dashboard.html`)

The artist home page, displayed after login:

- **Profile Summary**: Avatar, name, and npub from NOSTR Kind 0 event
- **Recent Releases**: Latest releases from NOSTR Kind 30050 events
- **Stats Overview**: Total tracks count (plays, sats, followers - TODO)
- **Quick Actions**: Upload new track, edit profile links

Navigating to `/admin` redirects to the dashboard (or login if not authenticated).

### Profile Editor (`/admin/profile.html`)

Allows artists to edit their NOSTR profile (Kind 0 event):

- **Profile Images**: Upload avatar and banner images to IPFS
- **Profile Information**: Name, bio, location, website, genres
- **NOSTR Identity**: View npub, configure NIP-05 and Lightning address
- **Publish**: Select relays and publish profile updates

### Settings (`/admin/settings.html`)

Manages relay configuration and account settings:

- **Relay Configuration**: Add, remove, and configure relays in your NIP-65 relay list
- **Read/Write Permissions**: Toggle relay permissions (read-only, write-only, or both)
- **NOSTR Identity**: View your public keys (npub and hex format)

### Session Management

The admin pages use a centralized in-memory session management system with a single login gateway.

#### Architecture

- **Single Login Point**: All admin pages redirect to `/admin/login.html` if not authenticated
- **In-Memory Only**: Private keys are stored only in memory, never in localStorage/sessionStorage
- **Session Cleared**: On tab close, idle timeout (30 min), or explicit logout

#### Login Methods

1. **NIP-07 Browser Extension** (Recommended)
   - Supports Alby, nos2x, and other NIP-07 compatible extensions
   - Private key never leaves the extension
   - Signing delegated to the extension

2. **Manual nsec Entry**
   - Enter your private key (nsec1...) directly
   - Key stored in memory only for the session duration

3. **Backup File Import**
   - Load an `equaliser-backup-*.json` file from onboarding
   - Restores keys and pre-fills profile data on the profile page
   - Useful for recovering or transferring identity between browsers

#### Status Bar

A persistent status bar appears at the top of all admin pages showing:
- **Connection Status**: Green pulsing indicator when connected
- **Identity**: Shortened npub badge
- **Session Duration**: How long you've been logged in
- **Navigation**: Quick links between Profile and Settings
- **Logout**: End session and clear all data

#### Security Features

- **Idle Timeout**: 30-minute inactivity timeout (audio/video playback aware)
- **Multi-Tab Sync**: Logout from one tab logs out all tabs via BroadcastChannel
- **No Persistence**: Keys never touch localStorage or cookies
- **Return URL**: Redirects back to original page after login

#### Files

- `orchestrator/js/session.js` - Core session manager
- `orchestrator/js/status-bar.js` - Status bar component
- `orchestrator/login.html` - Login gateway page

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

## IPFS Node

The content node runs a Kubo IPFS daemon for decentralised content storage.

### Gateway Configuration

The IPFS gateway is automatically configured on container startup to use path-style URLs (e.g., `/ipfs/CID`) instead of subdomain-style URLs. This is handled by `ipfs/configure-gateway.sh` which runs via the container entrypoint.

This ensures images and content load correctly through the nginx proxy without browser redirect issues.

### Key Features

- **Content Storage**: Encrypted HLS segments stored with unique CIDs
- **Gateway Access**: Content served via `/ipfs/{CID}` through nginx
- **API Access**: Port 5001 for orchestrator to upload content
- **P2P Network**: Port 4001 for connecting to the IPFS network

### Data Persistence

IPFS data is stored in the Docker volume `ipfs-data`.

See [IPFS.md](./ipfs/IPFS.md) for detailed configuration and operations.

## Orchestrator API

The orchestrator is a FastAPI backend that handles content processing:

- **Track Upload**: Accept audio files and metadata
- **HLS Encoding**: Convert to streaming format with FFmpeg
- **IPFS Integration**: Upload segments and get CIDs
- **NOSTR Publishing**: Create Kind 30050 track events

Access the upload UI at `/admin/upload.html`.

See [ORCHESTRATOR.md](./ORCHESTRATOR.md) for full API documentation.

### Future Enhancements

- AES-256 encryption of HLS segments
- Strike payment webhooks
- Decryption key distribution via NIP-44

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
- [IPFS/Kubo](https://github.com/ipfs/kubo)
- [Onboarding Documentation](./ONBOARDING.md)
- [Orchestrator API](./ORCHESTRATOR.md)
- [IPFS Documentation](./IPFS.md)
