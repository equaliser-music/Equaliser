#!/bin/sh
#
# Configure IPFS gateway to use path-style URLs instead of subdomain redirects
# This runs after ipfs init but before ipfs daemon
#

# Configure gateway to use path-style URLs (no subdomain redirects)
# This ensures /ipfs/CID URLs work through our nginx proxy
ipfs config --json Gateway.PublicGateways '{"localhost": {"UseSubdomains": false, "Paths": ["/ipfs", "/ipns"]}}'

# Configure API to listen on all interfaces (required for inter-container communication)
# Without this, the API only listens on 127.0.0.1 and other containers can't reach it
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001

# Configure Gateway to listen on all interfaces (required for nginx proxy)
# Without this, the gateway only listens on 127.0.0.1 and nginx can't reach it
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080

echo "IPFS configured: path-style gateway URLs, API and Gateway listening on 0.0.0.0"
