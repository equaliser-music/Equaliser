"""
NIP-26 delegation verifier.

Used by /api/tracks/publish to verify that a Kind 30050 event signed by a label
carries a valid delegation tag from the artist whose catalogue it joins.

Tag format: ["delegation", <delegator_pubkey>, <conditions>, <delegator_signature>]
Canonical message signed: SHA256("nostr:delegation:<delegatee_pubkey>:<conditions>")
"""

import hashlib
import logging
from typing import Optional, Tuple

import secp256k1

logger = logging.getLogger(__name__)


def find_delegation_tag(event: dict) -> Optional[list]:
    """Return the first ["delegation", ...] tag, or None."""
    for tag in event.get("tags", []) or []:
        if len(tag) >= 4 and tag[0] == "delegation":
            return tag
    return None


def verify_delegation_signature(
    delegator_pubkey: str,
    delegatee_pubkey: str,
    conditions: str,
    signature: str,
) -> bool:
    """Verify the BIP-340 Schnorr signature of the canonical NIP-26 delegation message."""
    canonical = f"nostr:delegation:{delegatee_pubkey}:{conditions}"
    digest = hashlib.sha256(canonical.encode()).digest()
    try:
        pubkey_bytes = b"\x02" + bytes.fromhex(delegator_pubkey)
        pubkey = secp256k1.PublicKey(pubkey_bytes, raw=True)
        sig_bytes = bytes.fromhex(signature)
        return pubkey.schnorr_verify(digest, sig_bytes, bip340tag=None, raw=True)
    except Exception as e:
        logger.warning(f"NIP-26 signature verify failed: {e}")
        return False


def conditions_allow(conditions: str, event_kind: int, event_created_at: int) -> bool:
    """
    Check whether a NIP-26 conditions string permits the given event.
    Supports: kind=N (one of), created_at>X (lower bound), created_at<Y (upper bound).
    Multiple kind= clauses are OR'd; created_at bounds tightened (max of >, min of <).
    """
    if not conditions:
        return False

    allowed_kinds: set[int] = set()
    min_time = 0
    max_time = 0

    for clause in conditions.split("&"):
        clause = clause.strip()
        if not clause:
            continue
        if clause.startswith("kind="):
            try:
                allowed_kinds.add(int(clause[len("kind="):]))
            except ValueError:
                pass
        elif clause.startswith("created_at>"):
            try:
                t = int(clause[len("created_at>"):])
                if t > min_time:
                    min_time = t
            except ValueError:
                pass
        elif clause.startswith("created_at<"):
            try:
                t = int(clause[len("created_at<"):])
                if max_time == 0 or t < max_time:
                    max_time = t
            except ValueError:
                pass

    if allowed_kinds and event_kind not in allowed_kinds:
        return False
    if min_time > 0 and event_created_at <= min_time:
        return False
    if max_time > 0 and event_created_at >= max_time:
        return False
    return True


def verify_event_delegation(event: dict) -> Tuple[bool, str, Optional[str]]:
    """
    Top-level helper for use in routers.

    Returns (ok, error_message, delegator_pubkey_or_None).

    On success, ok=True and delegator_pubkey is the artist on whose behalf the event was
    signed. The caller should then ALSO check that the delegation hasn't been revoked
    server-side (via relay_admin.get_active_delegation).
    """
    tag = find_delegation_tag(event)
    if tag is None:
        return False, "no delegation tag", None

    delegator = tag[1]
    conditions = tag[2]
    signature = tag[3]
    signer = event.get("pubkey", "")
    kind = event.get("kind", 0)
    created_at = event.get("created_at", 0)

    if not verify_delegation_signature(delegator, signer, conditions, signature):
        return False, "invalid delegation signature", None
    if not conditions_allow(conditions, kind, created_at):
        return False, "delegation conditions do not permit this event", None
    return True, "", delegator


# ===== Phase G: performer-tag attribution (label-as-publisher) =====
#
# Phase G models traditional record labels: the label IS the publisher and rights-holder.
# The Kind 30050 event is signed by the label, and the artist is named via:
#     ["p", <artist_pubkey>, "", "performer"]
# No cryptographic signature is required from the artist — the publish gate is purely
# server-side: only the artist's current `managed_by` label can publish for them.


def find_performer_tag(event: dict) -> Optional[list]:
    """Return the first `["p", artist_pubkey, "", "performer"]` tag, or None."""
    for tag in event.get("tags", []) or []:
        if len(tag) >= 4 and tag[0] == "p" and tag[3] == "performer" and tag[1]:
            return tag
    return None


def verify_event_performer_attribution(event: dict) -> Tuple[bool, str, Optional[str]]:
    """
    Phase G — pre-publish validation of label-signed events with performer attribution.

    Returns (ok, error_message, performer_pubkey_or_None).

    Does NOT enforce strict-mode (current-label check) — that's the router's job, because it
    needs the relay's node_artists lookup. This helper just structurally validates the tag.
    """
    tag = find_performer_tag(event)
    if tag is None:
        return False, "no performer tag", None
    performer = tag[1]
    if performer == event.get("pubkey", ""):
        # Self-attribution is a no-op — treat as self-publish, not Phase G
        return False, "performer equals signer (self-publish, not Phase G)", None
    return True, "", performer
