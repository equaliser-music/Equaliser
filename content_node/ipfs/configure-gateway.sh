#!/bin/sh
#
# Configure IPFS gateway to use path-style URLs instead of subdomain redirects
# This runs after ipfs init but before ipfs daemon
#

# Configure gateway to use path-style URLs (no subdomain redirects)
# This ensures /ipfs/CID URLs work through our nginx proxy
ipfs config --json Gateway.PublicGateways '{"localhost": {"UseSubdomains": false, "Paths": ["/ipfs", "/ipns"]}}'

echo "IPFS gateway configured for path-style URLs"
