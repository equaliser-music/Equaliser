# Equaliser: Decentralised Music Platform

## 1. Executive Summary: Equaliser – Decentralised Music Platform

**The Opportunity**

The music industry faces fundamental challenges: artists struggle with unfair revenue splits, platform censorship, and lack of direct fan engagement, while Bitcoin and Nostr ecosystems seek meaningful real-world adoption beyond speculation. Equaliser bridges this gap by creating a decentralised music platform that empowers artists with direct monetisation while demonstrating the practical utility of Bitcoin payments and Nostr's censorship-resistant communication.

**The Solution**

Equaliser is a decentralised music platform built on Bitcoin and Nostr protocols that enables:
- **Direct artist-to-fan monetisation** through Bitcoin micropayments and Lightning Network transactions
- **Censorship-resistant content distribution** via Nostr's decentralised relay network  
- **True ownership** of music rights and fan relationships, free from platform intermediaries
- **Global accessibility** with borderless payments and communication

**Value for the Music Community**
- Artists retain 100% of direct fan payments (minus minimal network fees)
- Freedom from algorithmic suppression and platform bans
- Direct communication channels with fans through Nostr
- New monetisation models: streaming micropayments, exclusive content sales, fan crowdfunding

**Value for Bitcoin & Nostr Ecosystems**
- Real-world utility driving organic Bitcoin adoption among creatives
- Demonstrates Nostr's potential beyond social media
- Creates sustainable economic incentives for network growth
- Showcases decentralised alternatives to Big Tech platforms

**The Vision**

Equaliser aims to become the primary platform where independent artists build sustainable careers through direct fan support, while simultaneously advancing Bitcoin and Nostr adoption through practical, everyday use cases. By solving real problems for creators, we create a blueprint for decentralised platforms that prioritise user sovereignty over corporate profit.

---

## 2. Introduction and Background

### The Problem: Challenges in the Modern Music Industry

The music industry is largely shaped by dominant streaming platforms and corporate intermediaries. These entities dictate terms, limit direct artist-fan relationships, and capture the majority of revenues, often leaving creators with only a modest share of the value their work produces. Algorithm-driven discovery and unpredictable content moderation present additional barriers to genuine creative expression.

Increasingly, these platforms prioritise monetisation above all else, exploring emerging technologies such as AI-generated artists to further maximise profits and control—potentially diluting human creativity and reducing opportunities for real musicians.

### Why Change Is Needed

For independent and aspiring artists, discovery and fair compensation are becoming more challenging as opaque systems and rising automation create new hurdles. Fans, meanwhile, have fewer ways to support and connect directly with authentic creators.

### An Evolving Solution: Bitcoin & Nostr

Bitcoin offers artists and fans an open, borderless way to exchange value instantly, without reliance on platform middlemen. The Lightning Network enables frictionless micropayments, streaming payments, and tipping.

Nostr provides a decentralised, censorship-resistant communication protocol, allowing artists to distribute content and build direct relationships with their audiences free from centralised platform control.

### Why Now?

Decentralised technologies now make it possible to create artist-first platforms centred on creative freedom and economic fairness. Equaliser leverages Bitcoin and Nostr to counterbalance profit-driven industry trends, restoring power and opportunity to real musicians and their communities.

---

## 3. The Project: Concept and Architecture

### Core Idea

Equaliser is a decentralised music platform empowering artists and fans through a network of independently operated nodes. By combining distributed storage, decentralised event publishing, and peer-to-peer payments, Equaliser offers robust, scalable music sharing and monetisation—without intermediaries.

### Design Philosophy

Many previous attempts to decentralise music distribution have relied on blockchain-based solutions for content storage, metadata, or network incentives—often resulting in expensive, slow transactions and limited scalability. Our approach is different:

- **No blockchain for content or metadata:**  
  We do **not** use blockchain technology to store music files or artist data. Blockchains add unnecessary complexity and inefficiency when used for high-volume data or rapidly changing events. Instead, IPFS handles distributed storage, and Nostr covers event publication and discovery—each purpose-built for performance, privacy, and scale.

- **No platform token:**  
  Equaliser does **not** issue a new token or cryptocurrency. Bitcoin—integrated with the Lightning Network—already enables fast, frictionless, and globally accessible micropayments. This ensures transparency and user trust, while avoiding risks of speculation and regulatory complications that come with proprietary tokens.

By choosing best-in-class open protocols and established digital currency, Equaliser provides a platform that is more scalable, efficient, and aligned with users' real needs.

### Technical Stack

An Equaliser content node is a bundled server with everything needed for decentralised music creation, delivery, and monetisation:

- **Nostr Relay:**  
  Each node operates its own Nostr relay, responsible for publishing, relaying, and discovering artist events, metadata, and content references across
