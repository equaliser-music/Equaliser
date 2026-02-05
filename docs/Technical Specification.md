# Equaliser Technical Specification

**Version:** 1.0  
**Date:** January 2026  
**Status:** Phase 1 MVP Specification

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Protocol Design](#3-protocol-design)
4. [Content Provider Node](#4-content-provider-node)
5. [Client Application](#5-client-application)
6. [Payment System](#6-payment-system)
7. [Security & Encryption](#7-security--encryption)
8. [Social Features](#8-social-features)
9. [Development Roadmap](#9-development-roadmap)
10. [Technical Requirements](#10-technical-requirements)

---

## 1. Executive Summary

### 1.1 Project Overview

Equaliser is a decentralised music streaming platform that empowers artists with direct monetisation, censorship-resistant distribution, and true ownership of their content and fan relationships. Built on open protocols (IPFS, NOSTR, Lightning), Equaliser addresses fundamental challenges in the modern music industry including unfair revenue splits, platform censorship, and lack of direct artist-fan engagement.

### 1.2 Core Value Proposition

**For Artists:**
- Direct fan payments via Strike (100% minus network fees)
- Censorship-resistant content distribution via IPFS
- True ownership of music rights and fan relationships
- Direct communication channels with fans via NOSTR
- Freedom from algorithmic suppression and platform risk

**For Fans:**
- Direct artist support with transparent revenue flow
- Global accessibility with borderless payments
- Privacy-preserving payment options (Cashu)
- Community-driven discovery free from corporate algorithms
- Low-cost streaming (micropayments competitive with traditional platforms)

**For Bitcoin & NOSTR Ecosystems:**
- Real-world utility driving organic adoption
- Demonstrates practical applications beyond speculation
- Sustainable economic incentives for network growth

### 1.3 Key Differentiators

| Feature | Description |
|---------|-------------|
| **No Blockchain Storage** | Content and metadata stored on IPFS and NOSTR, avoiding blockchain bloat and costs |
| **No Platform Token** | Uses Bitcoin/Lightning via Strike, with optional Cashu for privacy |
| **Protocol-First** | Open-source protocol specification enabling third-party innovation |
| **Node-Based Architecture** | Artists run their own infrastructure with full control |
| **Pay-Per-Stream** | Micropayment model that's economically competitive with traditional streaming |

### 1.4 Design Philosophy

Equaliser takes a fundamentally different approach from blockchain-based music platforms:

- **No blockchain for content or metadata:** Blockchains add unnecessary complexity and inefficiency for high-volume data. IPFS handles distributed storage, NOSTR covers event publication and discovery.
- **No platform token:** Bitcoin already enables fast, frictionless, globally accessible micropayments via Lightning. No speculative token needed.
- **Best-in-class protocols:** Choose proven, purpose-built open protocols for each function rather than forcing everything onto a single blockchain.

---

## 2. System Architecture

### 2.1 High-Level Architecture

Equaliser employs a hybrid decentralized architecture with three main components:

**Content Provider Node:** Runs IPFS daemon, NOSTR relay, and orchestration layer. Connects to Strike API for payments. Optional Cashu mint for privacy.

**Client Application:** Web-based PWA that connects to NOSTR relays, fetches content from IPFS, and manages Strike wallet integration for auto-payments.

**Payment Rails:** Strike API for fiat-to-BTC and Lightning payments. Optional Cashu for anonymous ecash payments.

```
┌─────────────────────────────────────────────────────────────┐
│                     Content Provider Node                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ IPFS Daemon  │  │ NOSTR Relay  │  │ Orchestration│      │
│  │  (Kubo)      │  │(nostr-rs-relay)│ │   Layer      │      │
│  │              │  │              │  │  (Python/     │      │
│  │ - Encrypted  │  │ - Events     │  │   FastAPI)    │      │
│  │   HLS        │  │ - Keys       │  │              │      │
│  │   segments   │  │ - Social     │  │ - Strike API │      │
│  │              │  │              │  │ - Cashu      │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket (NOSTR)
                              │ HTTP (IPFS)
                              │ Strike API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                      │
│                         (Web PWA)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ HLS.js       │  │ NOSTR Client │  │ Strike       │      │
│  │ Player       │  │              │  │ Wallet       │      │
│  │              │  │ - Subscribe  │  │              │      │
│  │ - Decrypt    │  │ - Fetch keys │  │ - Budget     │      │
│  │ - Stream     │  │ - Social     │  │ - Auto-pay   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

**Content Publishing Flow:**
1. Artist uploads track via dashboard
2. Node encodes to HLS segments with FFmpeg
3. Segments encrypted (AES-256), except first 30s
4. Upload encrypted segments to IPFS → receive CIDs
5. Create NOSTR event (kind 30050) with metadata + CIDs
6. Broadcast event to NOSTR relays

**Content Access Flow:**
1. User clicks Play on track
2. Fetch unencrypted 30s preview from IPFS
3. Play preview automatically (free)
4. At 30s mark → check monthly budget
5. If budget allows → auto-payment via Strike
6. Artist node receives Strike webhook
7. Node publishes decryption key (kind 30052, NIP-44 encrypted)
8. Client receives key, decrypts it
9. Fetch encrypted segments from IPFS
10. Decrypt segments client-side
11. Continue seamless playback
12. Create payment receipt (kind 30053)

---

## 3. Protocol Design

### 3.1 NOSTR Event Kinds

Equaliser uses standard NOSTR events where possible and custom parameterized replaceable events (30000-39999 range) for platform-specific content.

**Standard Event Kinds:**
- **Kind 0:** Artist profiles
- **Kind 1:** Artist posts/updates
- **Kind 3:** Following/contact lists
- **Kind 7:** Reactions/likes

**Equaliser-Specific Event Kinds:**
- **Kind 30050:** Track metadata
- **Kind 30051:** Album metadata
- **Kind 30052:** Encrypted decryption keys
- **Kind 30053:** Payment receipts
- **Kind 30001:** User playlists (standard NOSTR list)

All Equaliser events include `["app", "Equaliser"]` tag for filtering.

### 3.2 Track Metadata Event (Kind 30050)

```json
{
  "kind": 30050,
  "pubkey": "<artist-nostr-pubkey>",
  "created_at": 1704067200,
  "content": "",
  "tags": [
    ["d", "<unique-track-id>"],
    ["app", "Equaliser"],
    ["title", "Sunset Dreams"],
    ["artist", "DJ Nova"],
    ["album", "Summer Nights"],
    ["genre", "Electronic"],
    ["duration", "245"],
    ["ipfs_manifest_cid", "QmManifest..."],
    ["ipfs_preview_cid", "QmPreview..."],
    ["price", "0.05"],
    ["price_currency", "USD"],
    ["release_date", "2026-01-15"],
    ["cover_art_cid", "QmCover..."]
  ]
}
```

### 3.3 Decryption Key Event (Kind 30052)

```json
{
  "kind": 30052,
  "pubkey": "<artist-pubkey>",
  "content": "<nip44-encrypted-key-for-user>",
  "tags": [
    ["d", "<unique-key-id>"],
    ["app", "Equaliser"],
    ["p", "<user-pubkey>"],
    ["e", "<track-event-id>"],
    ["payment_hash", "<strike-invoice-id>"]
  ]
}
```

Key is encrypted using NIP-44 specifically for the user's public key. Only they can decrypt it with their private key.

### 3.4 Payment Receipt Event (Kind 30053)

```json
{
  "kind": 30053,
  "pubkey": "<user-pubkey>",
  "tags": [
    ["d", "<receipt-id>"],
    ["app", "Equaliser"],
    ["e", "<track-event-id>"],
    ["p", "<artist-pubkey>"],
    ["amount_sats", "100"],
    ["payment_method", "strike"],
    ["timestamp", "1704067305"]
  ]
}
```

User creates this after payment to track spending for budget enforcement.

---

## 4. Content Provider Node

### 4.1 Architecture

The content provider node is a Docker Compose deployment with:

- **IPFS Daemon (kubo):** Stores and serves encrypted HLS segments
- **NOSTR Relay (nostr-rs-relay):** Handles event publishing and delivery
- **Orchestration Layer (Python/FastAPI):** Coordinates all components
- **PostgreSQL/SQLite:** Local metadata and analytics
- **Strike API Integration:** Payment processing

### 4.2 Technology Stack

- **Language:** Python 3.10+
- **Web Framework:** FastAPI
- **IPFS:** go-ipfs (kubo) 0.25+
- **NOSTR Relay:** nostr-rs-relay
- **Database:** PostgreSQL 15 or SQLite
- **Media Processing:** FFmpeg
- **Encryption:** cryptography library (AES-256, NIP-44)

### 4.3 Content Processing Pipeline

```python
async def process_track_upload(audio_file, metadata):
    # 1. Encode to HLS with FFmpeg
    hls_segments = await encode_to_hls(audio_file)
    
    # 2. Generate encryption key (random AES-256)
    encryption_key = os.urandom(32)
    store_key(metadata['track_id'], encryption_key)
    
    # 3. Encrypt segments (except first 30s)
    preview_segments = hls_segments[:5]  # First 30s
    encrypted_segments = []
    
    for i, segment in enumerate(hls_segments):
        if i < 5:
            # Leave preview unencrypted
            preview_segments.append(segment)
        else:
            # Encrypt with AES-256-CBC
            encrypted = encrypt_segment(segment, encryption_key)
            encrypted_segments.append(encrypted)
    
    # 4. Upload to IPFS
    preview_cid = await upload_to_ipfs(preview_segments)
    manifest_cid = await upload_to_ipfs(encrypted_segments + manifest)
    
    # 5. Create and publish NOSTR event
    event = create_track_event(metadata, manifest_cid, preview_cid)
    await publish_to_nostr(event)
    
    return {"track_id": metadata['track_id'], "event_id": event.id}
```

### 4.4 Payment Webhook Handler

```python
@app.post("/webhooks/strike")
async def handle_strike_webhook(request: Request):
    payload = await request.json()
    signature = request.headers.get('X-Strike-Signature')
    
    # Verify signature
    if not verify_webhook_signature(payload, signature):
        raise HTTPException(status_code=401)
    
    if payload['eventType'] == 'invoice.paid':
        invoice_id = payload['data']['invoiceId']
        
        # Look up track and user for this invoice
        invoice_data = await get_invoice(invoice_id)
        track_event_id = invoice_data['track_id']
        user_pubkey = invoice_data['user_pubkey']
        
        # Send decryption key
        await send_decryption_key(track_event_id, user_pubkey, invoice_id)
    
    return {"status": "ok"}

async def send_decryption_key(track_id, user_pubkey, payment_hash):
    # Get track's encryption key
    key = get_track_key(track_id)
    
    # Encrypt key for user using NIP-44
    encrypted_key = nip44_encrypt(key, user_pubkey)
    
    # Create and publish key event
    event = {
        "kind": 30052,
        "content": encrypted_key,
        "tags": [
            ["d", f"key-{payment_hash}"],
            ["app", "Equaliser"],
            ["p", user_pubkey],
            ["e", track_id],
            ["payment_hash", payment_hash]
        ]
    }
    
    await publish_nostr_event(event)
```

### 4.5 Artist Dashboard

Web-based interface built with React:

**Features:**
- Track upload with metadata entry
- View catalog and analytics
- Edit track information
- Manage pricing
- View revenue and streams
- Monitor node health

---

## 5. Client Application

### 5.1 Technology Stack

- **Framework:** React 18+ with TypeScript
- **State Management:** Zustand
- **NOSTR Client:** nostr-tools
- **HLS Player:** hls.js
- **Crypto:** Web Crypto API
- **Payment:** Strike SDK
- **PWA:** Service Workers with Workbox

### 5.2 Strike Wallet Integration

```typescript
class StrikeWallet {
  async connect() {
    // OAuth flow to Strike
    const authUrl = `https://strike.me/oauth2/authorize?${new URLSearchParams({
      client_id: STRIKE_CLIENT_ID,
      redirect_uri: window.location.origin + '/callback',
      scope: 'partner.invoice.read partner.invoice.write',
      response_type: 'code'
    })}`;
    
    window.location.href = authUrl;
  }
  
  async payInvoice(invoiceId: string): Promise<boolean> {
    const response = await fetch(
      `https://api.strike.me/v1/invoices/${invoiceId}/payment`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.ok;
  }
}
```

### 5.3 Auto-Payment Flow

```typescript
async function handlePreviewEnd(trackId: string, priceAmount: number, priceCurrency: string) {
  // 1. Convert price to sats using live exchange rate
  const priceSats = priceCurrency === 'SAT' ? priceAmount : await convertToSats(priceAmount, priceCurrency);

  // 2. Check monthly budget
  const canPay = await budgetService.checkBudget(priceSats);
  if (!canPay) {
    showNotification('Monthly budget exhausted');
    return false;
  }

  // 3. Request invoice from artist node (sats amount)
  const invoice = await requestInvoice(trackId, priceSats);

  // 4. Auto-pay via Strike
  const success = await strikeWallet.payInvoice(invoice.id);

  if (success) {
    // 5. Record payment for budget tracking
    await budgetService.recordPayment(priceSats, trackId);
    
    // 5. Wait for decryption key from NOSTR
    const key = await waitForDecryptionKey(trackId);
    
    return key;
  }
  
  return false;
}
```

### 5.4 Budget Management

```typescript
class BudgetService {
  private settings = {
    monthlyLimitSats: 10000,
    perStreamMaxSats: 200
  };
  
  async checkBudget(streamCost: number): Promise<boolean> {
    // Check per-stream limit
    if (streamCost > this.settings.perStreamMaxSats) {
      return false;
    }
    
    // Calculate monthly spend from NOSTR receipts
    const monthStart = getMonthStartTimestamp();
    const receipts = await nostr.fetchEvents({
      kinds: [30053],
      authors: [getUserPubkey()],
      since: monthStart
    });
    
    const totalSpent = receipts.reduce((sum, r) => {
      const amount = r.tags.find(t => t[0] === 'amount_sats')?.[1];
      return sum + parseInt(amount || '0');
    }, 0);
    
    return (totalSpent + streamCost) <= this.settings.monthlyLimitSats;
  }
  
  async recordPayment(amount: number, trackId: string) {
    // Create payment receipt event
    const event = {
      kind: 30053,
      tags: [
        ["d", `receipt-${Date.now()}`],
        ["app", "Equaliser"],
        ["e", trackId],
        ["amount_sats", amount.toString()],
        ["payment_method", "strike"],
        ["timestamp", Math.floor(Date.now() / 1000).toString()]
      ]
    };
    
    await nostr.signAndPublish(event);
  }
}
```

### 5.5 HLS Player with Decryption

```typescript
function HLSPlayer({ manifestCid, previewCid, decryptionKey, onPreviewEnd }) {
  const videoRef = useRef<HTMLAudioElement>(null);
  const [isPreview, setIsPreview] = useState(true);
  
  useEffect(() => {
    const hls = new Hls({
      xhrSetup: (xhr, url) => {
        if (!isPreview && decryptionKey) {
          xhr.responseType = 'arraybuffer';
        }
      }
    });
    
    // Start with preview
    hls.loadSource(`http://localhost:8080/ipfs/${previewCid}`);
    hls.attachMedia(videoRef.current);
    
    // Monitor playback
    videoRef.current.addEventListener('timeupdate', (e) => {
      if (isPreview && e.target.currentTime >= 30) {
        setIsPreview(false);
        onPreviewEnd(); // Trigger payment
      }
    });
    
    return () => hls.destroy();
  }, []);
  
  // Switch to full track after payment
  useEffect(() => {
    if (!isPreview && decryptionKey) {
      // Fetch encrypted segments, decrypt, play
      // ... decryption logic
    }
  }, [isPreview, decryptionKey]);
  
  return <audio ref={videoRef} controls />;
}
```

---

## 6. Payment System

### 6.1 Strike Integration

**User Side:**
- Users connect Strike account via OAuth
- Set monthly budget in app
- Payments happen automatically when preview ends
- Budget tracked via NOSTR receipts (kind 30053)

**Artist Side:**
- Artists connect Strike account to node
- Generate API key and webhook URL
- Receive payments directly to Strike balance
- Can withdraw to on-chain wallet

### 6.2 Cashu Integration (Optional)

For privacy-conscious users:

```typescript
// Swap BTC for Cashu tokens
async function swapBTCForCashu(amountSats: number) {
  const wallet = new Wallet({ mintUrl: ARTIST_MINT_URL });
  const quote = await wallet.requestMint(amountSats);
  
  // Pay Lightning invoice via Strike
  await strikeWallet.payInvoice(quote.invoice);
  
  // Mint tokens
  const tokens = await wallet.mint(amountSats, quote.hash);
  localStorage.setItem('cashu_tokens', JSON.stringify(tokens));
  
  return tokens;
}

// Pay with Cashu for complete anonymity (priceSats already converted from fiat)
async function payCashuForStream(trackId: string, priceSats: number) {
  const wallet = new Wallet({ mintUrl: ARTIST_MINT_URL });
  const tokens = JSON.parse(localStorage.getItem('cashu_tokens'));
  
  wallet.addTokens(tokens);
  const { send, remaining } = await wallet.send(priceSats);
  
  // Send tokens to artist node
  await fetch(`${ARTIST_NODE}/api/cashu-payment`, {
    method: 'POST',
    body: JSON.stringify({ trackId, tokens: send })
  });
  
  localStorage.setItem('cashu_tokens', JSON.stringify(remaining));
}
```

---

## 7. Security & Encryption

### 7.1 Content Encryption

**Algorithm:** AES-256-CBC
- Random 256-bit key per track
- 128-bit IV per segment
- IV prepended to ciphertext

```python
def encrypt_segment(plaintext: bytes, key: bytes) -> bytes:
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    encryptor = cipher.encryptor()
    
    # Pad to block size
    padding_len = 16 - (len(plaintext) % 16)
    padded = plaintext + bytes([padding_len] * padding_len)
    
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return iv + ciphertext  # IV + ciphertext
```

### 7.2 Key Distribution (NIP-44)

Keys encrypted for specific users using NIP-44:

```python
def nip44_encrypt(plaintext: str, sender_privkey, recipient_pubkey) -> str:
    # Compute shared secret via ECDH
    shared_secret = sender_privkey.compute_shared_secret(recipient_pubkey)
    encryption_key = hashlib.sha256(shared_secret).digest()
    
    # Encrypt with ChaCha20
    nonce = os.urandom(12)
    cipher = Cipher(algorithms.ChaCha20(encryption_key, nonce), mode=None)
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(plaintext.encode()) + encryptor.finalize()
    
    return base64.b64encode(nonce + ciphertext).decode()
```

### 7.3 Key Management

**Artist Node:**
- Master key stored encrypted on disk (restricted permissions)
- Track keys encrypted with master key
- Regular key rotation procedures

**Client:**
- Recommend NOSTR browser extensions (NIP-07) for key management
- Alternative: encrypted localStorage with user password

---

## 8. Social Features

### 8.1 Following Artists

```typescript
async function followArtist(artistPubkey: string) {
  const contacts = await nostr.fetchContactList(userPubkey);
  const updatedTags = [...contacts.tags, ["p", artistPubkey]];
  
  await nostr.signAndPublish({
    kind: 3,
    content: "",
    tags: updatedTags
  });
}
```

### 8.2 Liking Tracks

```typescript
async function likeTrack(trackEventId: string, artistPubkey: string) {
  await nostr.signAndPublish({
    kind: 7,
    content: "🔥",
    tags: [
      ["e", trackEventId],
      ["p", artistPubkey],
      ["app", "Equaliser"]
    ]
  });
}
```

### 8.3 Playlists

```typescript
async function createPlaylist(name: string, trackIds: string[]) {
  await nostr.signAndPublish({
    kind: 30001,
    content: "",
    tags: [
      ["d", `playlist-${Date.now()}`],
      ["app", "Equaliser"],
      ["title", name],
      ...trackIds.map(id => ["e", id])
    ]
  });
}
```

---

## 9. Development Roadmap

### 9.1 Phase 1: MVP (Q1-Q2 2026)

**Timeline:** 6 months

**Features:**
- Docker Compose deployment
- Python orchestration layer
- IPFS + NOSTR integration
- Strike payment integration
- Cashu ecash support
- HLS streaming with encryption
- 30s previews with auto-payment
- Web client (PWA)
- Basic social (follow, like, playlists)
- Artist dashboard

**Deliverables:**
- Protocol specification
- Reference implementation
- Documentation
- Testnet with 10-20 pioneer artists

**Success Metrics:**
- 20+ active nodes
- 100+ tracks published
- 500+ users
- <3s payment settlement

### 9.2 Phase 2: Growth (Q3-Q4 2026)

**Features:**
- Self-hosted Lightning nodes
- Shopify/fiat integration
- Mobile apps (iOS/Android)
- Desktop app
- Umbrel/Start9 packages
- Comments & reposts
- Enhanced analytics

**Goals:**
- 500+ artist nodes
- 10,000+ users
- $50,000+ monthly revenue

### 9.3 Phase 3: Advanced (2027+)

**Features:**
- Zero-knowledge subscriptions
- Streaming micropayments
- P2P content assistance
- Artist DAOs
- Advanced features

**Goals:**
- 2,000+ nodes
- 100,000+ users
- Self-sustaining ecosystem

---

## 10. Technical Requirements

### 10.1 Node Requirements

**Minimum:**
- CPU: 2 cores
- RAM: 4 GB
- Storage: 100 GB SSD
- Bandwidth: 10 Mbps
- OS: Ubuntu 20.04+

**Recommended:**
- CPU: 4+ cores
- RAM: 8+ GB
- Storage: 500+ GB SSD
- Bandwidth: 100+ Mbps
- OS: Ubuntu 22.04 LTS

### 10.2 Client Requirements

**Web (PWA):**
- Modern browser with WebSocket, Web Crypto API
- Chrome 90+, Firefox 88+, Safari 14+

**Mobile (Phase 2):**
- iOS 14+, Android 10+

**Desktop (Phase 2):**
- Windows 10+, macOS 11+, Linux

---

## Appendices

### Appendix A: Docker Compose Example

```yaml
version: '3.8'

services:
  ipfs:
    image: ipfs/kubo:latest
    ports:
      - "4001:4001"
      - "8080:8080"
    volumes:
      - ./ipfs-data:/data/ipfs

  nostr-relay:
    image: scsibug/nostr-rs-relay:latest
    ports:
      - "8008:8008"
    volumes:
      - ./nostr-data:/usr/src/app/db

  orchestrator:
    build: ./orchestrator
    ports:
      - "8000:8000"
    environment:
      - IPFS_API=http://ipfs:5001
      - NOSTR_RELAY=ws://nostr-relay:8008
      - STRIKE_API_KEY=${STRIKE_API_KEY}
    depends_on:
      - ipfs
      - nostr-relay
```

### Appendix B: Glossary

- **AES-256:** Advanced Encryption Standard with 256-bit keys
- **Cashu:** Ecash protocol for Bitcoin with blind signatures
- **CID:** Content Identifier in IPFS
- **HLS:** HTTP Live Streaming protocol
- **IPFS:** InterPlanetary File System
- **Lightning:** Bitcoin Layer 2 for instant payments
- **NIP:** NOSTR Implementation Possibility
- **NOSTR:** Notes and Other Stuff Transmitted by Relays
- **PWA:** Progressive Web App
- **Strike:** Lightning wallet and payment service

---

**End of Technical Specification**

Version 1.0 | January 16, 2026
