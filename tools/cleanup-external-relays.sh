#!/usr/bin/env bash
#
# cleanup-external-relays.sh — Development tool to delete test events from external relays.
#
# Reads npub/nsec from backup files in packages/artists/ and packages/users/,
# queries standard relays for events from those pubkeys, and sends NIP-09
# Kind 5 deletion events signed with the original private keys.
#
# DEVELOPMENT ONLY — this permanently deletes events from public relays.
#
# Usage:
#   ./tools/cleanup-external-relays.sh                # Dry run (show what would be deleted)
#   ./tools/cleanup-external-relays.sh --execute      # Actually delete events
#   ./tools/cleanup-external-relays.sh --relay wss://relay.damus.io  # Target specific relay
#   ./tools/cleanup-external-relays.sh -h             # Show help
#
# Prerequisites:
#   - python3 with coincurve and websockets (pip install coincurve websockets)
#   - Backup files in packages/artists/ and packages/users/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PACKAGES_DIR="$PROJECT_DIR/packages"

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
DRY_RUN=true
SPECIFIC_RELAY=""

# Default external relays to clean
DEFAULT_RELAYS=(
    "wss://relay.damus.io"
    "wss://relay.primal.net"
    "wss://nos.lol"
    "wss://relay.nostr.band"
)

show_help() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Delete test events from external NOSTR relays (development only)."
    echo ""
    echo "Options:"
    echo "  --execute         Actually delete events (default is dry run)"
    echo "  --relay URL       Target a specific relay (can be repeated)"
    echo "  --artists-only    Only clean artist pubkeys"
    echo "  --users-only      Only clean user pubkeys"
    echo "  -h, --help        Show this help"
    echo ""
    echo "Default relays: ${DEFAULT_RELAYS[*]}"
}

ARTISTS_ONLY=false
USERS_ONLY=false
CUSTOM_RELAYS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --execute)
            DRY_RUN=false
            shift
            ;;
        --relay)
            CUSTOM_RELAYS+=("$2")
            shift 2
            ;;
        --artists-only)
            ARTISTS_ONLY=true
            shift
            ;;
        --users-only)
            USERS_ONLY=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            show_help
            exit 1
            ;;
    esac
done

if [[ ${#CUSTOM_RELAYS[@]} -gt 0 ]]; then
    RELAYS=("${CUSTOM_RELAYS[@]}")
else
    RELAYS=("${DEFAULT_RELAYS[@]}")
fi

# Collect backup files
BACKUP_FILES=()
if [[ "$USERS_ONLY" != "true" ]]; then
    for f in "$PACKAGES_DIR"/artists/equaliser-backup-*.json; do
        [[ -f "$f" ]] && BACKUP_FILES+=("$f")
    done
fi
if [[ "$ARTISTS_ONLY" != "true" ]]; then
    for f in "$PACKAGES_DIR"/users/equaliser-backup-*.json; do
        [[ -f "$f" ]] && BACKUP_FILES+=("$f")
    done
fi

if [[ ${#BACKUP_FILES[@]} -eq 0 ]]; then
    echo -e "${RED}No backup files found in $PACKAGES_DIR${NC}"
    exit 1
fi

echo -e "${CYAN}=== Equaliser External Relay Cleanup ===${NC}"
if $DRY_RUN; then
    echo -e "${YELLOW}DRY RUN — no events will be deleted. Use --execute to delete.${NC}"
fi
echo ""
echo -e "Backup files: ${#BACKUP_FILES[@]}"
echo -e "Target relays: ${RELAYS[*]}"
echo ""

# Run the Python script
python3 - "$DRY_RUN" "${BACKUP_FILES[@]}" -- "${RELAYS[@]}" <<'PYEOF'
import asyncio
import hashlib
import json
import sys
import time

try:
    from coincurve import PrivateKey
except ImportError:
    print("ERROR: coincurve required. Install: pip install coincurve", file=sys.stderr)
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("ERROR: websockets required. Install: pip install websockets", file=sys.stderr)
    sys.exit(1)


def load_identities(backup_files):
    """Load pubkey/privkey pairs from backup files."""
    identities = []
    for path in backup_files:
        try:
            with open(path) as f:
                data = json.load(f)
            keys = data.get("keys", {})
            pubkey = keys.get("publicKeyHex", "")
            privkey = keys.get("privateKeyHex", "")
            name = data.get("profile", {}).get("name", "Unknown")
            if pubkey and privkey:
                identities.append({
                    "name": name,
                    "pubkey": pubkey,
                    "privkey": privkey,
                    "file": path,
                })
        except Exception as e:
            print(f"  Warning: could not read {path}: {e}")
    return identities


def compute_event_id(event):
    """Compute NIP-01 event ID (SHA-256 of serialized event)."""
    serialized = json.dumps(
        [0, event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"]],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def sign_event(event, privkey_hex):
    """Sign a NOSTR event with Schnorr signature."""
    event_id = compute_event_id(event)
    event["id"] = event_id
    pk = PrivateKey(bytes.fromhex(privkey_hex))
    sig = pk.sign_schnorr(bytes.fromhex(event_id))
    event["sig"] = sig.hex()
    return event


def create_deletion_event(pubkey, privkey, event_ids):
    """Create a NIP-09 Kind 5 deletion event."""
    tags = [["e", eid] for eid in event_ids]
    event = {
        "pubkey": pubkey,
        "created_at": int(time.time()),
        "kind": 5,
        "tags": tags,
        "content": "Cleaning up test events",
    }
    return sign_event(event, privkey)


async def query_relay(relay_url, pubkeys, timeout=15):
    """Query a relay for events from the given pubkeys."""
    events = []
    try:
        async with websockets.connect(relay_url, close_timeout=5, open_timeout=10) as ws:
            req = json.dumps(["REQ", "cleanup", {"authors": pubkeys, "limit": 500}])
            await ws.send(req)

            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=timeout)
                    data = json.loads(msg)
                    if data[0] == "EVENT":
                        events.append(data[2])
                    elif data[0] == "EOSE":
                        break
                except asyncio.TimeoutError:
                    break

            await ws.send(json.dumps(["CLOSE", "cleanup"]))
    except Exception as e:
        print(f"  Error connecting to {relay_url}: {e}")
    return events


async def delete_from_relay(relay_url, deletion_events, timeout=15):
    """Send deletion events to a relay."""
    results = {"accepted": 0, "rejected": 0, "errors": 0}
    try:
        async with websockets.connect(relay_url, close_timeout=5, open_timeout=10) as ws:
            for del_event in deletion_events:
                msg = json.dumps(["EVENT", del_event])
                await ws.send(msg)

                # Wait for OK response
                try:
                    resp = await asyncio.wait_for(ws.recv(), timeout=timeout)
                    data = json.loads(resp)
                    if data[0] == "OK":
                        if data[2]:  # accepted
                            results["accepted"] += 1
                        else:
                            results["rejected"] += 1
                            if "duplicate" not in data[3]:
                                print(f"    Rejected: {data[3]}")
                except asyncio.TimeoutError:
                    results["errors"] += 1
    except Exception as e:
        print(f"  Error sending deletions to {relay_url}: {e}")
        results["errors"] += len(deletion_events)
    return results


async def main():
    args = sys.argv[1:]

    # Parse args: DRY_RUN backup_files... -- relay_urls...
    dry_run = args[0].lower() == "true"
    separator = args.index("--")
    backup_files = args[1:separator]
    relay_urls = args[separator + 1:]

    # Load identities
    identities = load_identities(backup_files)
    if not identities:
        print("No valid identities found in backup files.")
        return

    print(f"Loaded {len(identities)} identities:")
    for ident in identities:
        print(f"  {ident['name']}: {ident['pubkey'][:16]}...")
    print()

    pubkeys = [i["pubkey"] for i in identities]
    pubkey_to_identity = {i["pubkey"]: i for i in identities}

    # Query each relay
    for relay_url in relay_urls:
        print(f"=== {relay_url} ===")
        events = await query_relay(relay_url, pubkeys)

        if not events:
            print("  No events found")
            print()
            continue

        # Group by pubkey
        by_pubkey = {}
        for e in events:
            by_pubkey.setdefault(e["pubkey"], []).append(e)

        total_events = 0
        deletion_events = []

        for pk, evts in by_pubkey.items():
            ident = pubkey_to_identity.get(pk)
            name = ident["name"] if ident else pk[:16] + "..."

            # Group by kind
            kinds = {}
            for e in evts:
                kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1

            kind_str = ", ".join(f"Kind {k}: {v}" for k, v in sorted(kinds.items()))
            print(f"  {name}: {len(evts)} events ({kind_str})")

            # Show events
            for e in evts:
                content = e.get("content", "")[:80]
                has_app = any(t[0] == "app" and len(t) >= 2 for t in e.get("tags", []))
                tag_str = " [Equaliser]" if has_app else ""
                print(f"    Kind {e['kind']}: {content}{tag_str}  ({e['id'][:16]}...)")

            total_events += len(evts)

            # Create deletion events (Kind 5 can't delete other Kind 5s, skip them)
            if ident:
                event_ids = [e["id"] for e in evts if e["kind"] != 5]
                if event_ids:
                    # Batch into groups of 20 (some relays limit tag count)
                    for i in range(0, len(event_ids), 20):
                        batch = event_ids[i:i + 20]
                        del_event = create_deletion_event(ident["pubkey"], ident["privkey"], batch)
                        deletion_events.append(del_event)

        print(f"\n  Total: {total_events} events, {len(deletion_events)} deletion event(s) to send")

        if dry_run:
            print(f"  \033[1;33mDRY RUN — skipping deletion\033[0m")
        elif deletion_events:
            print(f"  Sending deletion events...")
            results = await delete_from_relay(relay_url, deletion_events)
            print(f"  Results: {results['accepted']} accepted, {results['rejected']} rejected, {results['errors']} errors")
        print()

    if dry_run:
        print("\033[1;33mThis was a dry run. Use --execute to actually delete events.\033[0m")


asyncio.run(main())
PYEOF
