# Equaliser

A decentralised music platform built on Bitcoin and Nostr protocols that empowers artists with direct monetisation and censorship-resistant content distribution.

## Overview

Equaliser enables artists to distribute music and receive payments directly from fans without platform intermediaries. The platform leverages:

- **Bitcoin & Lightning Network** for instant, low-fee micropayments where artists retain 100% of fan payments
- **Nostr** for censorship-resistant content discovery and artist-fan communication
- **IPFS** for distributed, encrypted music storage and streaming

## Key Features

- Direct artist-to-fan payments with no platform cut
- Censorship-resistant content publishing
- True ownership of music, data, and fan relationships
- Privacy-focused payment options including ecash (Cashu)
- Decentralised streaming via encrypted HLS segments
- NIP-05 verification for artist authenticity

## Architecture

Equaliser operates through independently run content nodes, each bundling:
- A Nostr relay for event publishing and discovery
- An IPFS gateway for music storage and streaming
- A Lightning node for payment processing

## Documentation

- [Functional Specification](Functional%20Specification.md) - Detailed platform design and architecture
- [Technical Specification](Technical%20Specification.md) - Implementation details

## License

Open source - community governed