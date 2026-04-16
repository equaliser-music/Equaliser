# Equaliser Subscription Payment Strategy

> **Status:** Draft for discussion  
> **Purpose:** Planning document for Claude Code project implementation  
> **Note:** This document captures exploratory discussion and requires further refinement before implementation. It serves as a basis for architectural planning and stakeholder conversations.

---

## Overview

This document outlines potential approaches for implementing subscription-based access to Equaliser, moving beyond pure pay-per-stream micropayments to support recurring revenue models while maintaining decentralisation and censorship resistance.

The core challenge: allow users to prove subscription status to artist nodes without requiring each node to manage its own subscription billing, while distributing trust across multiple independent operators.

---

## Design Constraints

1. **No user identity hiding required** — Artist nodes can know which npub is streaming; the goal is proving subscription validity, not anonymity
2. **Decentralisation** — No single point of failure or control over subscription issuance
3. **Censorship resistance** — System must survive attempts to shut down individual operators
4. **Artist trust** — Revenue distribution must be transparent and verifiable
5. **NOSTR-native coordination** — Leverage existing protocol infrastructure where possible

---

## Subscription Proof Mechanism

### Simple Credential Model

When a user subscribes, the subscription service issues a signed credential:

```json
{
  "user_pubkey": "npub1abc...",
  "tier": "standard",
  "valid_until": 1740000000,
  "issuer": "equaliser-main",
  "signature": "<signed by subscription service>"
}
```

Artist nodes verify credentials by:
1. Checking the signature against known trusted issuers' public keys
2. Confirming the credential hasn't expired
3. Granting access without processing payment

This is straightforward credential verification — no zero-knowledge proofs required since user identity disclosure is acceptable.

---

## Payment Pool Options

### Option 1: Custodial Pool (MVP)

**How it works:**  
Equaliser operates a Strike account receiving subscription payments. Monthly payouts calculated from play counts, batch-sent to artist Lightning addresses.

**Trust model:**  
Artists trust Equaliser to report play counts honestly and distribute funds.

**Pros:**
- Simple to implement
- Works with existing Strike integration
- Low operational overhead

**Cons:**
- Single point of trust and failure
- Vulnerable to legal pressure or platform risk

**Recommendation:** Suitable for MVP; publish transparent payout reports so artists can verify against their own node logs.

---

### Option 2: Multisig Treasury

**How it works:**  
A 2-of-3 or 3-of-5 multisig holds subscription funds. Signers include Equaliser, artist representatives, and neutral third parties. Payouts require multiple signatures.

**Trust model:**  
Distributed trust — no single party can abscond with funds.

**Pros:**
- Eliminates single-party risk
- On-chain transparency

**Cons:**
- On-chain settlement expensive for many small payouts
- Coordination overhead for signers
- Still a single logical pool

**Recommendation:** Good intermediate step. Could fund a Lightning node for actual artist payments while multisig holds reserves.

---

### Option 3: Fedimint

**How it works:**  
A federated Chaumian ecash system with multiple guardians collectively controlling the subscription pool. No single guardian can access funds alone.

**Trust model:**  
Threshold trust — requires guardian collusion to compromise.

**Pros:**
- Built-in Lightning gateway for payments
- Ecash provides payment privacy if desired later
- Natural fit for artist-governed cooperatives

**Cons:**
- More complex to operate
- Younger technology, less battle-tested
- Requires recruiting and coordinating guardians

**Recommendation:** Strong candidate for post-MVP. Federation could include artist representatives, Equaliser, and community figures (OpenSats, HRF).

---

### Cashu vs Fedimint

Both are Chaumian ecash on Bitcoin with identical privacy mechanisms (blind signatures). The difference is trust distribution:

| Aspect | Cashu | Fedimint |
|--------|-------|----------|
| Operator model | Single mint operator | Multiple guardians (threshold) |
| Trust | Trust one party completely | Trust that threshold won't collude |
| Complexity | Simple deployment | Coordination overhead |
| Failure mode | Operator disappears = funds lost | Requires multiple guardian failures |

**Recommendation:**  
- Cashu: suitable for per-artist payments where fans already trust the artist
- Fedimint: suitable for shared subscription pools requiring distributed trust

---

## Federation of Federations

### The Vision

Multiple independent subscription pools serving different communities, with cross-pool access and revenue settlement:

- **Equaliser Global Pool** — main public subscription
- **Genre-specific collectives** — artist cooperatives (e.g., Indie Electronic, UK Jazz)
- **Label pools** — labels operating their own subscriptions
- **Regional pools** — jurisdiction-specific operators

Users subscribe to one pool but stream from artists across all participating pools. Pools settle revenue periodically based on cross-pool consumption.

### Credential Issuance

Each pool issues credentials scoped to their pool:

```json
{
  "user_pubkey": "npub1abc...",
  "pool_id": "indie-electronic-collective",
  "valid_until": 1740000000,
  "signature": "<pool signing key>"
}
```

Artist nodes maintain a registry of trusted pools and their public keys.

### Cross-Pool Verification

When a user presents a credential from a different pool:
1. Node verifies signature against that pool's known public key
2. Confirms pool is in the node's trusted set
3. Grants access
4. Logs play with originating pool ID for settlement

### Inter-Pool Settlement

Pools exchange play reports at settlement intervals:

```
Pool A → Pool B: "Your subscribers played 50,000 tracks from our artists"
Pool B → Pool A: "Your subscribers played 120,000 tracks from our artists"
```

Net settlement flows from the pool whose users consumed more from the other.

### NOSTR Coordination Layer

**Pool Registry Events (proposed Kind 30060):**

```json
{
  "kind": 30060,
  "pubkey": "<pool operator pubkey>",
  "tags": [
    ["d", "indie-electronic-collective"],
    ["name", "Indie Electronic Collective"],
    ["signing_pubkey", "<credential signing key>"],
    ["lightning_address", "settlement@indie-collective.xyz"],
    ["federation_type", "fedimint"],
    ["members", "142"]
  ]
}
```

**Settlement Attestation Events (proposed Kind 30061):**

```json
{
  "kind": 30061,
  "content": "<signed settlement data>",
  "tags": [
    ["d", "settlement-2026-01"],
    ["from_pool", "equaliser-global"],
    ["to_pool", "indie-electronic-collective"],
    ["plays", "50000"],
    ["amount_sats", "250000"],
    ["payment_hash", "abc123..."]
  ]
}
```

Both pools sign settlement events, creating mutual attestation and public audit trail.

---

## Censorship Resistance Architecture

### Threat Model

Adversaries may attempt to shut down mints through:
- Legal pressure (DMCA, money transmission regulations)
- Infrastructure attacks (hosting takedowns, domain seizures)
- Economic attacks (liquidity draining, DoS)

### Redundant Credential Issuance

Users receive credentials from multiple independent issuers upon subscription:

```json
{
  "user_pubkey": "npub1abc...",
  "valid_until": 1740000000,
  "credentials": [
    { "issuer": "equaliser-main", "signature": "..." },
    { "issuer": "indie-collective", "signature": "..." },
    { "issuer": "sovereign-music-dao", "signature": "..." }
  ]
}
```

Artist nodes accept credentials from *any* trusted issuer. If one mint is shut down, credentials from others remain valid.

### Cross-Mint Attestation Protocol

1. User pays Lightning invoice to any participating mint
2. Receiving mint issues credential and broadcasts signed attestation to NOSTR
3. Other mints observe attestation, verify payment proof, issue their own credentials
4. User holds multiple valid credentials from independent issuers

**Subscription Attestation Event (proposed Kind 30062):**

```json
{
  "kind": 30062,
  "pubkey": "<mint pubkey>",
  "tags": [
    ["d", "subscription-attestation-xyz"],
    ["user", "npub1abc..."],
    ["tier", "standard"],
    ["paid_sats", "10000"],
    ["valid_until", "1740000000"],
    ["payment_proof", "<lightning preimage>"]
  ]
}
```

### Jurisdictional Distribution

Mints should operate across different legal jurisdictions:
- **EU (Switzerland/Germany)** — strong privacy laws
- **Bitcoin-friendly (El Salvador)** — regulatory clarity
- **Decentralised operators** — multiple countries
- **Anonymous (Tor-only)** — operators unknown, maximum resistance

### Surviving Mint Failure

**For credentials:** User's other credentials remain valid; no service disruption.

**For settlement revenue:** Mitigations include:
- Frequent settlement (weekly/daily) to reduce exposure
- Fedimint over single-operator Cashu (requires multiple guardian failures)
- Collateral bonds covering one month's expected settlement
- Streaming settlement via BOLT12/keysend (revenue never pools)

### Anonymous Mint Option

For maximum censorship resistance, support mints where operators are unknown:
- Tor-only access
- No KYC on operators or users
- Fedimint guardians communicate only through Tor

Trade-off: harder to use (latency, no legal recourse) but impossible to shut down through legal channels.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    User Subscribes                          │
└─────────────────────┬───────────────────────────────────────┘
                      │ Pays any mint
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Mint Network (Multiple Independent)            │
│                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ Equaliser   │ │   Indie     │ │  Anon Mint  │           │
│  │ Main (CH)   │ │ Collective  │ │  (Tor-only) │           │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘           │
│         │               │               │                   │
│         └───────────────┼───────────────┘                   │
│                         │                                   │
│         NOSTR attestation propagation (Kind 30062)          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│        User receives credentials from all mints             │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      Artist Node                            │
│                                                             │
│  • Accepts credential from ANY trusted mint                 │
│  • Logs plays with originating pool ID                      │
│  • Mint A down? Credential from Mint B works                │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Settlement Layer                           │
│                                                             │
│  • Play counts aggregated per pool                          │
│  • Inter-pool settlement via NOSTR attestations             │
│  • Lightning payments to artist addresses                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Recommended Implementation Phases

### Phase 1: MVP (Custodial)
- Single Equaliser-operated subscription pool
- Strike for payment processing
- Simple signed credentials
- Transparent published payout reports
- Artists verify against own node logs

### Phase 2: Distributed Trust
- Migrate to Fedimint with multiple guardians
- Guardian set includes artist representatives
- Maintain backward compatibility with Phase 1 credentials

### Phase 3: Federation of Pools
- Define NOSTR event kinds for pool registry and settlement
- Enable independent pools to join network
- Implement cross-pool credential verification
- Build settlement coordination protocol

### Phase 4: Censorship Resistance
- Multi-mint credential issuance
- Cross-mint attestation propagation
- Jurisdictional distribution of operators
- Optional anonymous mint support

---

## Open Questions

1. **Guardian recruitment:** Who would serve as Fedimint guardians? What's the incentive structure?

2. **Settlement frequency:** Daily vs weekly vs monthly? Trade-off between operational overhead and mint failure exposure.

3. **Pool trust bootstrapping:** How do new pools join the trusted network? Staking requirements? Reputation systems?

4. **Credential revocation:** How to handle refunds or subscription cancellations across multiple issuers?

5. **Price normalisation:** How to handle cross-pool settlement when subscription prices differ between pools?

6. **Play count verification:** How do artists verify reported play counts without full access to all user streaming data?

7. **NOSTR event kind allocation:** Need to coordinate with NIP process for new event kinds (30060, 30061, 30062).

8. **Regulatory considerations:** Money transmission licensing implications for mint operators in various jurisdictions.

---

## Related Documents

- `equaliser-technical-specification.md` — Core platform architecture
- `CONTENT_NODE.md` — Artist node implementation
- `NODE-MANAGEMENT-SPEC.md` — Node administration interface
- `USER_CACHE.md` — User data caching strategy

---

## References

- [Fedimint](https://fedimint.org/) — Federated Chaumian ecash
- [Cashu](https://cashu.space/) — Single-operator ecash
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) — Encrypted payloads
- [BOLT12](https://bolt12.org/) — Lightning offers for streaming payments
