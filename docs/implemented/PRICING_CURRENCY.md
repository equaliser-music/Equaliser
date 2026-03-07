# Pricing Currency

**Status:** Planned

---

## Overview

Artists and labels can denominate stream prices in their preferred fiat currency (USD, GBP, EUR, JPY, etc.) or in satoshis directly. Payments always settle via Bitcoin Lightning. The content node converts the fiat price to sats at invoice time using a live exchange rate.

---

## How It Works

1. Artist sets a **preferred currency** in their profile (e.g. `GBP`)
2. When uploading a track, artist sets price in that currency (e.g. `0.04 GBP`)
3. Price is stored in the Kind 30050 event as `["price", "0.04"]` + `["price_currency", "GBP"]`
4. When a listener triggers payment, the content node:
   - Looks up the current BTC exchange rate
   - Converts `0.04 GBP` → sats
   - Generates a Lightning invoice for that sat amount
5. Artist's per-stream revenue intent stays stable regardless of BTC price movements

Artists who prefer to price in sats can set `price_currency: SAT` and the value is used directly with no conversion.

---

## Data Model

### Artist Preference (Kind 0 Profile)

Add `price_currency` to the profile metadata stored in the Kind 0 NOSTR event:

```json
{
  "name": "DJ Nova",
  "about": "...",
  "picture": "...",
  "price_currency": "GBP",
  "default_track_price": "0.04"
}
```

- `price_currency` — ISO 4217 currency code (e.g. `USD`, `GBP`, `EUR`, `JPY`) or `SAT`
- `default_track_price` — default price for new tracks in the preferred currency

New tracks inherit these values. The profile editor should include fields for both.

### Track Metadata (Kind 30050)

Replace `price_sats` with currency-aware fields:

```json
{
  "kind": 30050,
  "tags": [
    ["d", "<track-id>"],
    ["title", "Sunset Dreams"],
    ["artist", "DJ Nova"],
    ["price", "0.04"],
    ["price_currency", "GBP"],
    ["ipfs_manifest_cid", "Qm..."],
    ["ipfs_preview_cid", "Qm..."]
  ]
}
```

- `price` — numeric string, amount in the specified currency
- `price_currency` — ISO 4217 code or `SAT`

### SQLite Drafts

Update the `draft_tracks` table:

```sql
-- Replace price_sats column with:
price_amount REAL NOT NULL DEFAULT 0.05,
price_currency TEXT NOT NULL DEFAULT 'USD'
```

---

## Exchange Rate Conversion

### At Invoice Time

When a listener plays a track past the preview:

1. Read `price` and `price_currency` from the track event
2. If `price_currency` is `SAT`, use the value directly
3. Otherwise, fetch the current BTC rate for that currency
4. Convert: `sats = (price / btc_rate) * 100_000_000`
5. Round to nearest sat
6. Generate Lightning invoice for that sat amount

### Rate Source

Options (in priority order):

1. **Strike API** — already integrated for payments, provides exchange rates
2. **Coindesk / CoinGecko API** — free, reliable fallback
3. **Cached rate** — cache the rate for a short window (e.g. 5 minutes) to avoid hitting the API on every stream

### Supported Currencies

Start with the major currencies that Strike supports:

| Code | Currency |
|------|----------|
| SAT  | Satoshis (no conversion) |
| USD  | US Dollar |
| GBP  | British Pound |
| EUR  | Euro |
| JPY  | Japanese Yen |

Extend as needed. The system is generic — any currency with a BTC exchange rate works.

---

## UI Changes

### Profile Editor (`/admin/profile.html`)

Add to the profile form:

- **Preferred Currency** — dropdown select (SAT, USD, GBP, EUR, JPY)
- **Default Track Price** — numeric input with currency symbol

These values are saved in the Kind 0 event and used as defaults for new uploads.

### Track Upload / Edit

- Price input shows the artist's preferred currency symbol
- Pre-fills with the artist's default track price
- Artist can override per-track

### Dashboard

- Display earnings in the artist's preferred currency (convert from sat totals)
- Show per-stream price in the preferred currency

---

## Implementation Steps

1. Update SQLite schema: replace `price_sats` with `price_amount` + `price_currency`
2. Update orchestrator upload/draft APIs to accept new fields
3. Update Kind 30050 event publishing to use `price` + `price_currency` tags
4. Add exchange rate lookup to the invoice generation endpoint
5. Update profile editor UI with currency preference fields
6. Update track upload/edit UI to use currency-aware pricing
7. Update dashboard to display earnings in preferred currency
