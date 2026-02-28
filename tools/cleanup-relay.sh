#!/usr/bin/env bash
# cleanup-relay.sh — Remove non-Equaliser events from the NOSTR relay.
#
# Deletes events that don't have the ['app', 'Equaliser'] tag,
# while preserving all events from known Equaliser pubkeys (artists,
# the node operator, and seeded users).
#
# Usage:
#   ./tools/cleanup-relay.sh              # Dry run (show what would be deleted)
#   ./tools/cleanup-relay.sh --execute    # Actually delete
#   ./tools/cleanup-relay.sh --local      # Run against local relay (not VPS)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Config ---
VPS_KEY="$HOME/.ssh/Hetzner_CPX22"
VPS_HOST="root@77.42.68.194"
DB_PATH="/usr/src/app/db/nostr.db"
RELAY_CONTAINER="equaliser-nostr-relay"

EXECUTE=false
LOCAL=false

for arg in "$@"; do
    case "$arg" in
        --execute) EXECUTE=true ;;
        --local)   LOCAL=true ;;
        -h|--help)
            echo "Usage: $0 [--execute] [--local]"
            echo ""
            echo "  --execute   Actually delete events (default is dry run)"
            echo "  --local     Run against local relay instead of VPS"
            echo ""
            echo "Removes events without ['app', 'Equaliser'] tag from the relay,"
            echo "preserving all events from known Equaliser pubkeys."
            exit 0
            ;;
    esac
done

# --- Build the protected pubkey list from backup files ---
PROTECTED_PUBKEYS=""

# Read pubkeys from all backup files in packages/users/
for backup in "$PROJECT_DIR"/packages/users/equaliser-backup-*.json; do
    [ -f "$backup" ] || continue
    pk=$(python3 -c "import json,sys; d=json.load(open('$backup')); print(d['keys']['publicKeyHex'])" 2>/dev/null || true)
    if [ -n "$pk" ]; then
        PROTECTED_PUBKEYS="${PROTECTED_PUBKEYS}'$(echo "$pk" | tr '[:lower:]' '[:upper:]')',"
    fi
done

# Read pubkeys from artist seed data (seed-feed.mjs private keys → derive pubkeys)
SEED_FEED="$SCRIPT_DIR/seed-feed.mjs"
if [ -f "$SEED_FEED" ]; then
    ARTIST_PUBKEYS=$(node --input-type=module -e "
        import { getPublicKey } from 'nostr-tools/pure';
        import { hexToBytes } from '@noble/hashes/utils';
        const keys = [
            '7e111d3b54eb0829d964d648d5dd0d87bbeeec60bb7fc2b7cb5cafa99d187c5d',
            '15504dbcf0e191f22e4d6f0fff135def1b989a46b0113c35da1e31d6d63356ff',
            '8cfdd8671e77b8dd0509eacb49c399f1b064677c5216f7046b022edc15b7c82f'
        ];
        keys.forEach(k => console.log(getPublicKey(hexToBytes(k)).toUpperCase()));
    " 2>/dev/null || true)

    for pk in $ARTIST_PUBKEYS; do
        PROTECTED_PUBKEYS="${PROTECTED_PUBKEYS}'${pk}',"
    done
fi

# Remove trailing comma
PROTECTED_PUBKEYS="${PROTECTED_PUBKEYS%,}"

if [ -z "$PROTECTED_PUBKEYS" ]; then
    echo "ERROR: No protected pubkeys found. Check packages/users/ for backup files."
    exit 1
fi

# The LIKE pattern to match the app tag in event JSON
# Using single quotes inside SQL, percent signs for LIKE wildcards
TAG_PATTERN='%"app","Equaliser"%'

# --- Helper to run sqlite3 via a temp SQL file (avoids shell escaping hell) ---
run_sql() {
    local sql="$1"
    local tmpfile
    tmpfile=$(mktemp /tmp/eq-cleanup-XXXXXX.sql)
    echo "$sql" > "$tmpfile"

    if [ "$LOCAL" = true ]; then
        cat "$tmpfile" | docker exec -i "$RELAY_CONTAINER" sqlite3 "$DB_PATH"
    else
        cat "$tmpfile" | ssh -i "$VPS_KEY" "$VPS_HOST" \
            "docker exec -i $RELAY_CONTAINER sqlite3 $DB_PATH"
    fi
    rm -f "$tmpfile"
}

kind_name() {
    case "$1" in
        0) echo "Profiles" ;; 1) echo "Notes" ;; 3) echo "Contacts" ;;
        4) echo "DMs" ;; 5) echo "Deletions" ;; 6) echo "Reposts" ;;
        7) echo "Reactions" ;; 10002) echo "Relay list" ;;
        30050) echo "Tracks" ;; 30051) echo "Albums" ;; *) echo "" ;;
    esac
}

echo "Equaliser Relay Cleanup"
echo "======================"
if [ "$LOCAL" = true ]; then
    echo "Target: local relay"
else
    echo "Target: VPS ($VPS_HOST)"
fi
echo ""

# --- Show current state ---
echo "Current event counts:"
echo ""
printf "  %-10s  %-10s  %-12s  %s\n" "Kind" "Tagged" "Untagged" "Description"
printf "  %-10s  %-10s  %-12s  %s\n" "----" "------" "--------" "-----------"

SUMMARY=$(run_sql "
SELECT
  kind,
  SUM(CASE WHEN content LIKE '${TAG_PATTERN}' THEN 1 ELSE 0 END),
  SUM(CASE WHEN content NOT LIKE '${TAG_PATTERN}' THEN 1 ELSE 0 END)
FROM event
GROUP BY kind
ORDER BY kind;
")

while IFS='|' read -r kind tagged untagged; do
    desc=$(kind_name "$kind")
    printf "  %-10s  %-10s  %-12s  %s\n" "$kind" "$tagged" "$untagged" "$desc"
done <<< "$SUMMARY"

echo ""

# --- Count what would be deleted ---
DELETE_COUNT=$(run_sql "
SELECT COUNT(*) FROM event
WHERE content NOT LIKE '${TAG_PATTERN}'
  AND hex(author) NOT IN ($PROTECTED_PUBKEYS);
")

PROTECTED_UNTAGGED=$(run_sql "
SELECT COUNT(*) FROM event
WHERE content NOT LIKE '${TAG_PATTERN}'
  AND hex(author) IN ($PROTECTED_PUBKEYS);
")

PK_COUNT=$(echo "$PROTECTED_PUBKEYS" | tr ',' '\n' | wc -l | tr -d ' ')
echo "Protected Equaliser pubkeys: $PK_COUNT"
echo "Untagged events from protected pubkeys (kept): $PROTECTED_UNTAGGED"
echo "Events to delete (untagged + not protected): $DELETE_COUNT"
echo ""

if [ "$DELETE_COUNT" = "0" ]; then
    echo "Nothing to clean up!"
    exit 0
fi

# Show breakdown of what would be deleted
echo "Deletion breakdown by kind:"
BREAKDOWN=$(run_sql "
SELECT kind, COUNT(*) FROM event
WHERE content NOT LIKE '${TAG_PATTERN}'
  AND hex(author) NOT IN ($PROTECTED_PUBKEYS)
GROUP BY kind
ORDER BY COUNT(*) DESC;
")

while IFS='|' read -r kind count; do
    desc=$(kind_name "$kind")
    printf "  Kind %-6s  %s events  %s\n" "$kind" "$count" "$desc"
done <<< "$BREAKDOWN"

echo ""

# --- Execute or dry run ---
if [ "$EXECUTE" = true ]; then
    echo "Deleting $DELETE_COUNT events..."

    run_sql "
DELETE FROM tag WHERE event_id IN (
    SELECT id FROM event
    WHERE content NOT LIKE '${TAG_PATTERN}'
      AND hex(author) NOT IN ($PROTECTED_PUBKEYS)
);
DELETE FROM event
WHERE content NOT LIKE '${TAG_PATTERN}'
  AND hex(author) NOT IN ($PROTECTED_PUBKEYS);
"

    REMAINING=$(run_sql "SELECT COUNT(*) FROM event;")
    echo "Done! $DELETE_COUNT events removed. $REMAINING events remaining."
else
    echo "This is a DRY RUN. To actually delete, run:"
    echo "  $0 --execute"
fi
