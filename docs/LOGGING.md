# Logging

How logging works across all Equaliser content node services.

## Viewing Logs

All services log to stdout, captured by Docker:

```bash
# All services
docker compose logs

# Single service (follow mode)
docker compose logs -f orchestrator
docker compose logs -f equaliser-relay

# Recent logs only
docker compose logs --since 10m orchestrator

# Filter out noise (e.g. health checks)
docker compose logs orchestrator 2>&1 | grep -v health
```

## Per-Service Logging

### Orchestrator (Python/FastAPI)

**Config:** `content_node/orchestrator/api/main.py` — `logging.basicConfig(level=logging.INFO)`

Uses Python's standard `logging` module. Each module creates its own logger:

```python
import logging
logger = logging.getLogger(__name__)
```

**Log levels used:**
- `logger.info()` — Successful operations (uploads, identity loaded, drafts created)
- `logger.warning()` — Recoverable failures (Blossom down, signature mismatch)
- `logger.error()` — Operation failures (upload errors, missing files)

**Key modules with logging:**

| Module | What it logs |
|--------|-------------|
| `services/node_identity.py` | Keypair generation/loading on startup |
| `services/blossom.py` | Upload success/failure, deduplication skips, error details with `X-Reason` header |
| `routers/tracks.py` | Upload status updates, Blossom failure warnings |
| `routers/packages.py` | Import progress, cover art upload warnings, track import results |
| `services/database.py` | Database initialisation path (uses `print`, not `logging`) |

**Uvicorn request logging:** FastAPI/Uvicorn automatically logs all HTTP requests at INFO level:
```
INFO: 127.0.0.1:40196 - "POST /api/releases/import HTTP/1.1" 200 OK
```

### Equaliser Relay (Go)

**Config:** `content_node/equaliser-relay/cmd/relay/main.go` — Go standard `log` package with timestamps and source file:

```go
log.SetFlags(log.LstdFlags | log.Lshortfile)
```

No log levels — all messages are printed. Output format: `2026/03/11 22:46:42 main.go:59: message`

**Key areas with logging:**

| Area | What it logs |
|------|-------------|
| Startup (`main.go`) | Config summary (name, policy, ports, peer count), shutdown signals |
| Peer syncer (`syncer.go`) | Connection/disconnection, reconnection backoff, EOSE events, event forwarding, subscription updates |
| WebSocket handler (`handler.go`) | Client connections, REQ/EVENT/CLOSE messages, query errors |
| Storage (`postgres.go`) | Database connection, migrations |
| Denorm parser (`denorm.go`) | Kind 0/30050/30051 parsing, user feed threshold enforcement |
| Event policy (`events.go`) | Event acceptance/rejection reasons, NIP-09 deletions |
| REST API (`api.go`) | User registration, catalogue queries |

**Peer syncer logging is verbose** — logs every connect/disconnect/reconnect cycle. With the known ~30s connection drop bug, expect frequent reconnection messages. These are informational, not errors.

### Nginx

**Config:** `content_node/web/nginx.conf` — no explicit log directives, uses nginx defaults.

- Access log: `/var/log/nginx/access.log` (inside container, not persistent)
- Error log: `/var/log/nginx/error.log`

View via: `docker compose exec web cat /var/log/nginx/access.log`

### PostgreSQL

Uses default PostgreSQL logging. Minimal output — mainly startup messages.

### Blossom

Third-party service (`hzrd149/blossom-server`). Logs startup config, storage setup, and admin dashboard URL. Upload/download operations are not logged by the Blossom server itself — the orchestrator logs these from its side.

### IPFS (Kubo)

Standard IPFS daemon logging. Verbose on startup (peer discovery, DHT). Not configured by Equaliser.

## Import/Upload Warning Visibility

Service failures during imports and uploads are surfaced in multiple places:

| Failure | Container Logs | Admin UI | Upload Status |
|---------|---------------|----------|---------------|
| Blossom down during track upload | `WARNING` in orchestrator logs | — | Status message: "Blossom unavailable" |
| Blossom down during package import | `WARNING` in orchestrator logs | Warning notification | — |
| IPFS down during package import | `WARNING` in orchestrator logs | Warning notification | — |
| Blossom down during cover art upload | `WARNING` in orchestrator logs | Error notification (upload fails) | — |

The `/api/releases/import` endpoint returns a `warnings` array in its response, which the admin releases page displays as notifications.

## Docker Log Retention

No custom log drivers are configured. Docker uses the default `json-file` driver:

- Logs persist until the container is removed (`docker compose down`)
- No log rotation configured — logs can grow indefinitely on long-running containers
- Logs are lost on `docker compose down -v` (volume wipe)

For production VPS deployments, consider adding log rotation:

```yaml
# docker-compose.override.yml
services:
  orchestrator:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

## Troubleshooting

### No logs appearing for a service

Check the container is running: `docker compose ps`

### Logger warnings not showing

The orchestrator's `logging.basicConfig(level=logging.INFO)` in `main.py` must be called before any module-level logger is created. If warnings from a module aren't appearing, check that `main.py` imports happen after `basicConfig()`.

### Filtering relay chatter

The peer syncer logs reconnection events every ~30s (known bug). Filter with:
```bash
docker compose logs equaliser-relay 2>&1 | grep -v 'reconnect\|disconnected'
```
