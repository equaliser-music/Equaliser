# IPFS Configuration

The content node runs a [Kubo](https://github.com/ipfs/kubo) IPFS daemon for decentralised content storage and delivery.

## Overview

IPFS (InterPlanetary File System) is used to store and serve encrypted music content. When artists upload tracks, the content is:

1. Encoded into HLS segments
2. Encrypted with AES-256 (except the 30-second preview)
3. Uploaded to IPFS, receiving a unique CID (Content Identifier)
4. Referenced in NOSTR events for discovery

## Container Details

| Setting | Value |
|---------|-------|
| Image | `ipfs/kubo:latest` |
| Container Name | `equaliser-ipfs` |
| Data Volume | `ipfs-data:/data/ipfs` |

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 4001 | TCP/UDP | P2P swarm (libp2p) - connects to IPFS network |
| 5001 | TCP | API - used by orchestrator to add content |
| 8080 | TCP | Gateway - serves content (proxied via nginx) |

## Accessing IPFS

### Via Nginx (Recommended)

Content is accessible through the nginx proxy at `/ipfs/{CID}`:

```
http://localhost/ipfs/QmYourContentCID
```

### Direct Gateway Access

The IPFS gateway is also available directly on port 8080 (internal to Docker network).

### API Access

The IPFS API on port 5001 is used by the orchestrator to:
- Add content: `POST /api/v0/add`
- Pin content: `POST /api/v0/pin/add`
- Get node info: `POST /api/v0/id`

Example adding content via API:
```bash
curl -X POST -F file=@myfile.mp3 "http://localhost:5001/api/v0/add"
```

## Configuration

The IPFS node must be configured to use path-style gateway URLs (not subdomain-style) for compatibility with the nginx proxy.

### First-Time Setup

After starting the containers for the first time, run this command to configure the gateway:

```bash
docker exec equaliser-ipfs ipfs config --json Gateway.PublicGateways '{"localhost": {"UseSubdomains": false, "Paths": ["/ipfs", "/ipns"]}}'
docker restart equaliser-ipfs
```

This configuration is persisted in the `ipfs-data` volume and only needs to be run once.

### Key Configuration Settings

- `Gateway.PublicGateways.localhost.UseSubdomains: false` - Use path-style URLs
- `Gateway.PublicGateways.localhost.Paths: ["/ipfs", "/ipns"]` - Enable IPFS and IPNS paths

### Viewing Configuration

```bash
docker exec equaliser-ipfs ipfs config show
```

### Modifying Configuration

```bash
docker exec equaliser-ipfs ipfs config <key> <value>
docker restart equaliser-ipfs
```

## Data Persistence

IPFS data is stored in the Docker volume `ipfs-data`. This includes:
- The IPFS repository (blocks, datastore)
- Configuration
- Pinned content

### Backup

```bash
docker-compose stop ipfs
docker run --rm -v content_node_ipfs-data:/data -v $(pwd):/backup alpine tar czf /backup/ipfs-backup.tar.gz /data
docker-compose start ipfs
```

### Restore

```bash
docker-compose stop ipfs
docker run --rm -v content_node_ipfs-data:/data -v $(pwd):/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/ipfs-backup.tar.gz -C /"
docker-compose start ipfs
```

## Health Check

The container includes a health check that verifies the IPFS daemon is responding:

```bash
ipfs dag stat /ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn
```

This fetches a well-known empty directory CID to confirm the node is operational.

## Common Operations

### Check Node Status

```bash
# Node identity and peer connections
docker exec equaliser-ipfs ipfs id

# Connected peers
docker exec equaliser-ipfs ipfs swarm peers

# Bandwidth stats
docker exec equaliser-ipfs ipfs stats bw
```

### Add Content

```bash
# Add a file
docker exec equaliser-ipfs ipfs add /path/to/file

# Add content from stdin
echo "Hello IPFS" | docker exec -i equaliser-ipfs ipfs add -q
```

### Retrieve Content

```bash
# Via CLI
docker exec equaliser-ipfs ipfs cat QmCID

# Via gateway
curl http://localhost/ipfs/QmCID
```

### Pin Content

Pinning ensures content is kept locally and not garbage collected:

```bash
# Pin a CID
docker exec equaliser-ipfs ipfs pin add QmCID

# List pinned content
docker exec equaliser-ipfs ipfs pin ls

# Unpin content
docker exec equaliser-ipfs ipfs pin rm QmCID
```

### Garbage Collection

Remove unpinned content to free space:

```bash
docker exec equaliser-ipfs ipfs repo gc
```

## Troubleshooting

### Node Not Starting

Check logs:
```bash
docker-compose logs ipfs
```

Common issues:
- Port 4001 or 5001 already in use
- Corrupted repository (delete volume and restart)

### Content Not Loading

1. Check the CID is valid
2. Verify the node is connected to peers: `docker exec equaliser-ipfs ipfs swarm peers`
3. Check if content is pinned locally: `docker exec equaliser-ipfs ipfs pin ls | grep QmCID`

### Gateway Returns 504 Timeout

The content might not be available on the network. Try:
1. Check if the content provider is online
2. Add the content provider as a peer: `docker exec equaliser-ipfs ipfs swarm connect /ip4/x.x.x.x/tcp/4001/p2p/PeerID`

## Security Considerations

- **API Access**: Port 5001 should not be exposed publicly. It's used internally by the orchestrator.
- **Gateway Access**: The gateway (via nginx) is read-only and safe for public access.
- **P2P Port**: Port 4001 must be accessible for the node to participate in the IPFS network.

## References

- [Kubo Documentation](https://docs.ipfs.tech/install/command-line/)
- [IPFS HTTP Gateway](https://docs.ipfs.tech/concepts/ipfs-gateway/)
- [IPFS API Reference](https://docs.ipfs.tech/reference/kubo/rpc/)
- [Technical Specification](../../Technical%20Specification.md)
