# Equaliser

**Own your music career: your catalogue, your community, your money — on infrastructure no one can take away from you.**

Equaliser is an open-source, self-hostable music platform. Artists (or their labels and collectives) run their own **content node** — a small Docker stack that serves their catalogue, hosts their fan community, and will route payments from fans directly to their own wallet. No platform account to be banned from, no algorithm to appease, no percentage skimmed in the middle.

Built on three proven open protocols, each doing one job:

| Protocol | Job |
|---|---|
| **Nostr** | Identity, catalogue metadata, and the artist–fan social layer — portable, signed, censorship-resistant |
| **IPFS** (+ [Blossom](https://github.com/hzrd149/blossom)) | Content-addressed music storage and HLS streaming; originals preserved for disaster recovery |
| **Bitcoin / Lightning** | Direct fan→artist payments, denominated in the fan's own currency — no tokens, no speculation, bitcoin as rails only |

## Principles

- **Non-custodial, always.** Keys are generated client-side and never touch a server. Payments (in development) go fan-wallet → artist-wallet; the platform never holds funds.
- **The exit is a feature.** Every release exports as a signed, portable package (`.eqpkg.zip`). If a node — or this project — disappeared tomorrow, artists lose nothing.
- **No company required.** The protocol works with zero companies in the loop. Anyone can run a node for themselves, their label, or their scene.
- **No algorithm.** Discovery is human: scenes, artist-curated playlists, and people you actually follow.
- **Fiat-first UX on bitcoin rails.** Fans see pounds/euros/dollars; artists can settle to their local currency. Bitcoin is plumbing, not vocabulary.

## Status (honest)

**Working today** — two federated nodes run in production:

- Full content pipeline: upload → FFmpeg HLS encode → IPFS, originals to Blossom, drafts → client-signed Nostr publish (Kind 30050/30051)
- Custom Go Nostr relay: PostgreSQL storage, full tag indexing, tiered event-acceptance policy, peer-to-peer sync between nodes, REST cache API
- Fan web app: streaming player, library & playlists (NIP-51), rich social layer (feeds, threads, communities, DMs, reactions, zap-ready profiles)
- Three-tier roles (artist / label / operator) with NIP-98 HTTP auth, gated onboarding, invite codes, and label-on-behalf-of-artist publishing (NIP-26 delegation *and* label-as-rights-holder models)
- Signed release packages for import/export/portability

**In development** — the current focus:

- **Payments**: NIP-57 zaps/tips to artists' own wallets first; then pay-to-own unlocks (encrypted HLS + NIP-44 key release); then patronage subscriptions — user-centric, pool-free. Pluggable provider layer (Lightning address, Nostr Wallet Connect, phoenixd, Strike, …)
- Search & discovery surfaces, mobile PWA, operator tooling for third-party node hosts

## Run a node

```bash
git clone https://github.com/equaliser-music/Equaliser.git
cd Equaliser
./tools/start-node.sh -d
```

Then open `http://localhost` — the relay prints a one-time **setup token** on first boot (`docker logs equaliser-relay | grep "setup token"`) which claims the node's first operator at `/admin/setup.html`. From there: onboard an artist, upload a track, publish, stream.

Requirements: Docker + Docker Compose. The stack: FastAPI orchestrator, custom Go relay, PostgreSQL, IPFS (Kubo), Blossom, nginx.

## Repository layout

| Path | What |
|---|---|
| `client/` | Fan-facing web app (vanilla JS, no build step) |
| `content_node/` | The node: orchestrator (FastAPI), Equaliser relay (Go), Docker Compose, nginx |
| `common/` | Shared session/auth JS used by both surfaces |
| `docs/` | Architecture and design docs — start with [CONTENT_NODE.md](docs/CONTENT_NODE.md), [EQUALISER_RELAY.md](docs/EQUALISER_RELAY.md), [ORCHESTRATOR.md](docs/ORCHESTRATOR.md) |
| `docs/original/` | The founding functional & technical specifications |
| `tools/` | Dev/ops scripts: start, reset, seed, import/export, deploy |

## Contributing

Early-stage and moving fast — issues, questions and scepticism all welcome. The docs in `docs/` are kept current and are the best map of the system.

Contact: **equaliser-music@proton.me** · [equaliser.app](https://equaliser.app)

## License

[AGPL-3.0](LICENSE) — the platform stays open, for everyone, permanently.
