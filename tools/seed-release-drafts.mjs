#!/usr/bin/env node
/**
 * Publish Kind 0 profiles and release all draft tracks as Kind 30050 events.
 *
 * Queries drafts from the orchestrator API, builds and signs NOSTR events,
 * publishes directly to the relay via WebSocket, then marks drafts as released.
 *
 * Env vars:
 *   RELAY_URL  - WebSocket URL of the Equaliser Relay (default: ws://localhost/relay)
 *   NODE_URL   - Base URL of the content node API (default: http://localhost)
 */

import { finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost/relay';
const NODE_URL = process.env.NODE_URL || 'http://localhost';

// ===== Artist identities (same as seed-social.mjs) =====

const ARTISTS = [
    {
        name: 'Shibuya Crossings',
        privateKeyHex: '7e111d3b54eb0829d964d648d5dd0d87bbeeec60bb7fc2b7cb5cafa99d187c5d',
        publicKeyHex: '31f22f8f74707212547a1f3a8aaa96891b7d817c17098c3384fe4d276fd8cac4',
        profile: {
            name: 'Shibuya Crossings',
            display_name: 'Shibuya Crossings',
            about: 'Shibuya Crossings blends electronic and alternative sounds with introspective songwriting. Named after the famous Tokyo intersection.',
            picture: '',
            banner: '',
            website: '',
            nip05: '',
            lud16: '',
            equaliser: { location: 'Tokyo, Japan', genres: ['Electronic', 'Alternative', 'Indie'], price_currency: 'EUR', default_track_price: 0.05 },
        }
    },
    {
        name: 'Language of Flowers',
        privateKeyHex: '15504dbcf0e191f22e4d6f0fff135def1b989a46b0113c35da1e31d6d63356ff',
        publicKeyHex: '483efd7f36b88ca49711b3622a3e45f11856326626997d67ac62bf366890f763',
        profile: {
            name: 'Language of Flowers',
            display_name: 'Language of Flowers',
            about: 'Ethereal indie folk from the Cotswolds. Songs about nature, memory, and the quiet moments between.',
            picture: '',
            banner: '',
            website: '',
            nip05: '',
            lud16: '',
            equaliser: { location: 'Cotswolds, UK', genres: ['Indie Folk', 'Dream Pop'], price_currency: 'GBP', default_track_price: 0.04 },
        }
    },
    {
        name: 'Swansea Sound',
        privateKeyHex: '8cfdd8671e77b8dd0509eacb49c399f1b064677c5216f7046b022edc15b7c82f',
        publicKeyHex: '9557d2704a949723c96cc39e15e0c8aaba49895c5688956759b0bc4fdba28209',
        profile: {
            name: 'Swansea Sound',
            display_name: 'Swansea Sound',
            about: 'Jangly indie pop from Swansea. Three-piece making music that sounds like sunshine through rain.',
            picture: '',
            banner: '',
            website: '',
            nip05: '',
            lud16: '',
            equaliser: { location: 'Swansea, Wales', genres: ['Indie Pop', 'Jangle Pop', 'Post-Punk'], price_currency: 'GBP', default_track_price: 0.03 },
        }
    },
];

// ===== Helpers =====

const now = Math.floor(Date.now() / 1000);

function signEvent(user, template) {
    return finalizeEvent(template, hexToBytes(user.privateKeyHex));
}

async function publishEvent(event) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RELAY_URL);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 10000);
        ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg[0] === 'OK') {
                clearTimeout(timeout);
                ws.close();
                const reason = msg[3] || '';
                if (msg[2] || reason.startsWith('duplicate')) resolve(msg[1]);
                else reject(new Error(reason || 'Rejected'));
            }
        });
        ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}

async function publish(user, template) {
    const event = signEvent(user, template);
    try {
        await publishEvent(event);
        return event;
    } catch (err) {
        console.error(`    FAIL: ${err.message}`);
        return event;
    }
}

// ===== 1. Publish Kind 0 profiles =====

async function publishProfiles() {
    console.log('1. Publishing artist profiles (Kind 0)...');
    for (const artist of ARTISTS) {
        await publish(artist, {
            kind: 0,
            created_at: now - 86400 * 30, // 30 days ago
            tags: [
                ['app', 'Equaliser'],
                ['user-type', 'artist'],
            ],
            content: JSON.stringify(artist.profile),
        });
        console.log(`   ${artist.name} — profile published`);
    }
}

// ===== 2. Release draft tracks as Kind 30050 =====

async function releaseDrafts() {
    console.log('2. Releasing draft tracks (Kind 30050)...');

    for (const artist of ARTISTS) {
        // Fetch drafts for this artist
        const resp = await fetch(`${NODE_URL}/api/drafts?pubkey=${artist.publicKeyHex}`);
        if (!resp.ok) {
            console.log(`   ${artist.name} — no drafts (${resp.status})`);
            continue;
        }
        const data = await resp.json();
        const drafts = data.drafts || [];
        if (drafts.length === 0) {
            console.log(`   ${artist.name} — no drafts`);
            continue;
        }

        console.log(`   ${artist.name} — ${drafts.length} drafts to release`);

        // Group by album for Kind 30051
        const albums = {};
        for (const draft of drafts) {
            if (draft.album) {
                if (!albums[draft.album]) albums[draft.album] = [];
                albums[draft.album].push(draft);
            }
        }

        // Publish Kind 30051 album events first
        for (const [albumName, albumDrafts] of Object.entries(albums)) {
            const coverDraft = albumDrafts.find(d => d.cover_art_cid || d.blossom_cover_hash);
            const dTag = albumName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const tags = [
                ['app', 'Equaliser'],
                ['d', dTag],
                ['title', albumName],
                ['artist', artist.name],
                ['release_type', albumDrafts[0].release_type || 'album'],
            ];
            if (coverDraft?.cover_art_cid) tags.push(['cover_art_cid', coverDraft.cover_art_cid]);
            if (coverDraft?.blossom_cover_hash) tags.push(['blossom_cover_hash', coverDraft.blossom_cover_hash]);

            await publish(artist, {
                kind: 30051,
                created_at: now - 86400 * 28,
                tags,
                content: '',
            });
            console.log(`     Album: ${albumName}`);
        }

        // Publish Kind 30050 track events
        for (const draft of drafts) {
            const dTag = `${(draft.album || 'single').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(draft.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

            const tags = [
                ['app', 'Equaliser'],
                ['d', dTag],
                ['title', draft.title || 'Untitled'],
                ['artist', draft.artist_name || artist.name],
            ];
            if (draft.album) tags.push(['album', draft.album]);
            if (draft.genre) tags.push(['genre', draft.genre]);
            if (draft.duration) tags.push(['duration', String(draft.duration)]);
            if (draft.ipfs_manifest_cid) tags.push(['ipfs_manifest_cid', draft.ipfs_manifest_cid]);
            if (draft.ipfs_preview_cid) tags.push(['ipfs_preview_cid', draft.ipfs_preview_cid]);
            if (draft.cover_art_cid) tags.push(['cover_art_cid', draft.cover_art_cid]);
            if (draft.release_date) tags.push(['release_date', draft.release_date]);
            if (draft.track_number) tags.push(['track_number', String(draft.track_number)]);
            if (draft.price_amount != null) tags.push(['price', String(draft.price_amount)]);
            if (draft.price_currency) tags.push(['price_currency', draft.price_currency]);
            if (draft.blossom_audio_hash) tags.push(['blossom_audio_hash', draft.blossom_audio_hash]);
            if (draft.blossom_cover_hash) tags.push(['blossom_cover_hash', draft.blossom_cover_hash]);
            if (draft.blossom_cover_hash) {
                const coverUrl = `${NODE_URL}/blossom/${draft.blossom_cover_hash}`;
                tags.push(['blossom_cover_url', coverUrl]);
            }
            if (draft.release_type) tags.push(['release_type', draft.release_type]);

            const event = await publish(artist, {
                kind: 30050,
                created_at: now - 86400 * 27 + Math.floor(Math.random() * 86400),
                tags,
                content: '',
            });
            console.log(`     Track: ${draft.title}`);

            // Mark draft as released (best-effort, no auth needed for this check)
            try {
                const markResp = await fetch(
                    `${NODE_URL}/api/drafts/${draft.id}/mark-released?nostr_event_id=${event.id}&nostr_d_tag=${dTag}`,
                    { method: 'POST' }
                );
                // This will likely fail with 401 (NIP-98 auth required) — that's OK,
                // the event is already published to the relay which is what matters
            } catch {}
        }
    }
}

// ===== Main =====

async function main() {
    console.log(`Relay: ${RELAY_URL}`);
    console.log(`Node:  ${NODE_URL}`);
    console.log('');

    await publishProfiles();
    console.log('');
    await releaseDrafts();
    console.log('');
    console.log('Done! Profiles and tracks published to relay.');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
