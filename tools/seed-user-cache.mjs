#!/usr/bin/env node
// ⚠️  INTENTIONAL TEST KEYS — NOT A LEAK
// The private keys below are throwaway DEV/TEST personas used only to seed
// demo data on local/test relays. They hold no funds and no real identity.
// Do NOT reuse this pattern for real identities (real keys live in gitignored packages/).
/**
 * Seed a standard NOSTR relay with test fan data for user cache testing.
 *
 * Publishes to the standard relay (nostr-rs-relay), NOT the Equaliser Relay.
 * Then registers each fan pubkey with the content node so the Equaliser Relay's
 * standard relay syncer discovers and caches the events.
 *
 * Env vars:
 *   RELAY_URL  - WebSocket URL of the standard relay (default: ws://localhost:7700)
 *   NODE_URL   - Base URL of the content node (default: http://localhost)
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:7700';
const NODE_URL = process.env.NODE_URL || 'http://localhost';

// ===== Test fan identities (same as seed-social.mjs) =====

const FANS = [
    { name: 'Maya Chen',      privateKeyHex: 'eaa526d913652c15f65b668fa008d64526e97a6345cb493e6d4b1cbaabbea59f', publicKeyHex: '798ac12221e376182ceb8c00ed231bfbd509b200f99640d54d4ea27629842614' },
    { name: 'Tom Ashworth',   privateKeyHex: '3ece8872f0eb7dea35c3393b55a6d96648591784dcd9d1ec34ee9f8b23efa640', publicKeyHex: '6706d4d86c93329c1215ac9e9db7284613e724c28d0ffd42c80e7f567a9098e4' },
    { name: 'Priya Kapoor',   privateKeyHex: '817fe0884806b429d9a3fd9d66a7818b366fa421bb54c8c32ceb0616d8def945', publicKeyHex: '0341481925291ba9d20f241a6309cb4a749f81253f46b03f42b0205d21bfa225' },
    { name: 'Jake Morrison',  privateKeyHex: '4696faa43e40ac516c3670e9068464cc2b596ae611ab70e26f65e539f560c822', publicKeyHex: 'b74da95a9e0307c330ff9c70722423674ae59dc686f829d960d87a5020283006' },
    { name: 'Suki Tanaka',    privateKeyHex: 'c66e4c43099d156cc98278cfc676a2455674ac00e335d3555c79312a57d1295c', publicKeyHex: '0bc7a37cbf106cac4fde294b32466e181541d8edbefaf10f14a1964b77bfb1c9' },
];

// Artists on the content node (pubkeys from seed-social.mjs)
const ARTIST_PUBKEYS = [
    '31f22f8f74707212547a1f3a8aaa96891b7d817c17098c3384fe4d276fd8cac4', // Shibuya Crossings
    '483efd7f36b88ca49711b3622a3e45f11856326626997d67ac62bf366890f763', // Language of Flowers
    '9557d2704a949723c96cc39e15e0c8aaba49895c5688956759b0bc4fdba28209', // Swansea Sound
];

// ===== Helpers =====

const now = Math.floor(Date.now() / 1000);
function hoursAgo(h) { return now - h * 3600; }
function daysAgo(d)  { return now - d * 86400; }

function signEvent(user, template) {
    return finalizeEvent(template, hexToBytes(user.privateKeyHex));
}

async function publishToRelay(event) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RELAY_URL);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 5000);

        ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg[0] === 'OK') {
                clearTimeout(timeout);
                ws.close();
                // msg[2] = accepted (bool), msg[3] = reason string
                // Duplicates are expected on re-runs — treat as success
                const reason = msg[3] || '';
                if (msg[2] || reason.startsWith('duplicate')) {
                    resolve(msg[1]);
                } else {
                    reject(new Error(reason || 'Rejected'));
                }
            }
        });
        ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}

async function publish(user, template) {
    const event = signEvent(user, template);
    try {
        await publishToRelay(event);
        return event;
    } catch (err) {
        console.error(`    FAIL: ${err.message}`);
        return event;
    }
}

async function registerWithNode(pubkey) {
    const url = `${NODE_URL}/api/users/register`;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey }),
        });
        if (!resp.ok) {
            console.error(`    Register FAIL (${resp.status}): ${await resp.text()}`);
            return false;
        }
        return true;
    } catch (err) {
        console.error(`    Register FAIL: ${err.message}`);
        return false;
    }
}

// ===== 1. Publish Kind 0 profiles (no app tag — standard NOSTR events) =====

async function seedProfiles() {
    console.log('1. Publishing fan profiles (Kind 0) to standard relay...');

    const profiles = [
        { user: FANS[0], profile: { name: 'Maya Chen', display_name: 'Maya Chen', about: 'Music lover. Indie and electronic fan. Always looking for new sounds.', picture: 'https://i.pravatar.cc/300?u=maya' } },
        { user: FANS[1], profile: { name: 'Tom Ashworth', display_name: 'Tom Ashworth', about: 'Vinyl collector and music blogger. Audiophile. Based in London.', picture: 'https://i.pravatar.cc/300?u=tom' } },
        { user: FANS[2], profile: { name: 'Priya Kapoor', display_name: 'Priya Kapoor', about: 'Songwriter and music enthusiast from Mumbai. Always writing, always listening.', picture: 'https://i.pravatar.cc/300?u=priya' } },
        { user: FANS[3], profile: { name: 'Jake Morrison', display_name: 'Jake Morrison', about: 'Sound engineer. Music quality nerd. Headphone addict.', picture: 'https://i.pravatar.cc/300?u=jake' } },
        { user: FANS[4], profile: { name: 'Suki Tanaka', display_name: 'Suki Tanaka', about: 'Live music fanatic from Tokyo. Shimokitazawa regular. Collects limited pressings.', picture: 'https://i.pravatar.cc/300?u=suki' } },
    ];

    for (const { user, profile } of profiles) {
        await publish(user, {
            kind: 0,
            content: JSON.stringify(profile),
            tags: [],
            created_at: daysAgo(10),
        });
        console.log(`   ${user.name} — profile published`);
    }
}

// ===== 2. Publish Kind 3 follow lists =====

async function seedFollowLists() {
    console.log('2. Publishing follow lists (Kind 3) to standard relay...');

    for (const fan of FANS) {
        // Each fan follows all three artists + a couple of other fans
        const tags = [
            ...ARTIST_PUBKEYS.map(pk => ['p', pk]),
            // Each fan follows 2 random other fans
            ...FANS.filter(f => f !== fan).slice(0, 2).map(f => ['p', f.publicKeyHex]),
        ];

        await publish(fan, {
            kind: 3,
            content: '',
            tags,
            created_at: daysAgo(8),
        });
        console.log(`   ${fan.name} — follow list published (${tags.length} follows)`);
    }
}

// ===== 3. Publish Kind 1 posts (standalone — no app tag) =====

async function seedPosts() {
    console.log('3. Publishing fan posts (Kind 1) to standard relay...');

    const posts = [
        { fan: FANS[0], content: 'Just discovered some incredible indie music today. The quality of streaming on decentralised platforms is really impressive now.', t: daysAgo(3) },
        { fan: FANS[0], content: 'Rainy afternoon playlist: ambient electronic, shoegaze, and lo-fi indie. Perfect combo.', t: daysAgo(1) },
        { fan: FANS[1], content: 'Spent the morning comparing audio formats. Lossless streaming is finally becoming accessible to everyone, not just audiophiles with expensive setups.', t: daysAgo(4) },
        { fan: FANS[1], content: 'New vinyl haul this weekend. Three records from independent labels. Supporting small artists directly feels great.', t: daysAgo(2) },
        { fan: FANS[2], content: 'Late night songwriting session. The melody came from humming along to a track I heard earlier. Inspiration really is everywhere.', t: daysAgo(3) },
        { fan: FANS[2], content: 'Mumbai rain + good headphones + new music = perfect evening.', t: hoursAgo(12) },
        { fan: FANS[3], content: 'PSA: if you are serious about music, invest in decent headphones before anything else. You would be amazed what you have been missing.', t: daysAgo(5) },
        { fan: FANS[3], content: 'Comparing waveforms between streaming platforms. The difference is real and measurable, not just audiophile placebo.', t: daysAgo(1) },
        { fan: FANS[4], content: 'Saw an amazing live set in Shimokitazawa last night. Small venues are where the real magic happens.', t: daysAgo(2) },
        { fan: FANS[4], content: 'My limited pressing collection is getting out of hand. But I regret nothing.', t: hoursAgo(6) },
    ];

    for (const { fan, content, t } of posts) {
        await publish(fan, {
            kind: 1,
            content,
            tags: [],    // No app tag — these are standard NOSTR posts
            created_at: t,
        });
        console.log(`   ${fan.name} — post published`);
    }
}

// ===== 4. Register fan pubkeys with content node =====

async function registerFans() {
    console.log('4. Registering fan pubkeys with content node...');

    for (const fan of FANS) {
        const ok = await registerWithNode(fan.publicKeyHex);
        console.log(`   ${fan.name} (${fan.publicKeyHex.slice(0, 12)}...) — ${ok ? 'registered' : 'FAILED'}`);
    }
}

// ===== Main =====

async function main() {
    console.log(`Standard relay: ${RELAY_URL}`);
    console.log(`Content node:   ${NODE_URL}`);
    console.log('');

    await seedProfiles();
    console.log('');

    await seedFollowLists();
    console.log('');

    await seedPosts();
    console.log('');

    await registerFans();
    console.log('');

    console.log('Done! The Equaliser Relay syncer will pick up these events on its next sync cycle.');
    console.log('');
    console.log('Verification:');
    console.log('  1. Check relay logs:  docker logs equaliser-relay 2>&1 | grep "standard relay"');
    console.log('  2. Check cached data: docker exec equaliser-postgres psql -U equaliser -c "SELECT pubkey, display_name FROM cached_users"');
    console.log('  3. Check follows:     docker exec equaliser-postgres psql -U equaliser -c "SELECT pubkey, follows_pubkey FROM cached_user_follows LIMIT 20"');
    console.log('  4. Check feed:        docker exec equaliser-postgres psql -U equaliser -c "SELECT event_id, pubkey, content FROM cached_user_feed LIMIT 10"');
    console.log('');
    console.log('Fan nsec keys (for client login testing):');
    for (const fan of FANS) {
        console.log(`  ${fan.name.padEnd(16)} ${fan.privateKeyHex}`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
