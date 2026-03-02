#!/usr/bin/env node
/**
 * Seed NOSTR relay with Kind 1 notes for test artists.
 * Usage: node tools/seed-feed.mjs
 */

import { finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import WebSocket from 'ws';

const RELAY_URL = 'ws://localhost/relay';

const artists = [
    {
        name: 'Shibuya Crossings',
        privateKeyHex: '7e111d3b54eb0829d964d648d5dd0d87bbeeec60bb7fc2b7cb5cafa99d187c5d',
        notes: [
            'Just finished mixing the new EP. The tracks from late night sessions in Shibuya turned out even better than expected. Can\'t wait to share them with you all.',
            'Tokyo rain hitting the studio windows at 2am. There\'s something about this city that makes everything sound different. New track coming soon.',
            'Played a set at a tiny venue in Shimokitazawa last night. 30 people, zero phones out, just pure connection through music. That\'s what it\'s all about.',
            'Been experimenting with field recordings from the crossing. The rhythm of thousands of footsteps has this hypnotic pulse to it. Might sample it for the next album.',
            'Thank you to everyone streaming Neon Reflections. The response has been incredible. Your support means everything to independent artists like us.',
            'Collaborating with a producer from Osaka next month. Blending our electronic textures with traditional instruments. Something completely new is coming.',
        ]
    },
    {
        name: 'Language of Flowers',
        privateKeyHex: '15504dbcf0e191f22e4d6f0fff135def1b989a46b0113c35da1e31d6d63356ff',
        notes: [
            'Writing from a garden in the Cotswolds today. Sometimes you need to step away from the studio to find the melody that\'s been hiding from you.',
            'New single "Petals in the Rain" is out now! This one\'s been in the works for months. Hope it finds you on a quiet evening when you need it most.',
            'Just discovered that our track "Violet Hour" has been added to three independent playlists. The indie community is so supportive.',
            'Recording vocals today. There\'s a crack in my voice on the bridge that I almost fixed, then realised it was the most honest part of the whole song. Left it in.',
            'Tea, rain, and a piano. That\'s all you need for a Sunday songwriting session.',
            'Playing our first headline show in Bristol next month! Tiny venue, big feelings. Link in bio if you want to join us.',
            'Been listening to a lot of Cocteau Twins lately. That ethereal quality is something I\'d love to weave into our next record.',
        ]
    },
    {
        name: 'Swansea Sound',
        privateKeyHex: '8cfdd8671e77b8dd0509eacb49c399f1b064677c5216f7046b022edc15b7c82f',
        notes: [
            'Just pressed 500 copies of the new 7" single. Proper vinyl, proper sleeve, proper indie. Available from the usual suspects.',
            'Rehearsal in Rob\'s shed today. We\'ve got three new songs that sound like 1986 never ended, and we couldn\'t be happier about that.',
            'Someone on a forum called us "the most joyful band in indie pop" and honestly that\'s the best review we\'ve ever had.',
            'New track "Corporate Indie Band Part 2" coming soon. Yes, we\'re still annoyed about the state of things. But at least we can dance about it.',
            'Just got back from an amazing gig in Cardiff. The crowd knew every word. When did that happen? Still pinching ourselves.',
            'Hue sent over a demo from his kitchen that sounds like the Pastels meets Television Personalities. Immediately said yes.',
            'Indie pop is alive and well, no matter what the algorithms tell you. Keep supporting small bands, small labels, small venues.',
            'Recording session tomorrow. We\'re going for that classic Sarah Records sound but with modern production. The best of both worlds.',
        ]
    }
];

async function publishEvent(event) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RELAY_URL);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Timeout'));
        }, 5000);

        ws.on('open', () => {
            ws.send(JSON.stringify(['EVENT', event]));
        });

        ws.on('message', (data) => {
            const raw = data.toString();
            const msg = JSON.parse(raw);
            if (msg[0] === 'OK') {
                clearTimeout(timeout);
                ws.close();
                if (msg[2]) {
                    resolve(msg[1]);
                } else {
                    reject(new Error(msg[3] || `Rejected (full response: ${JSON.stringify(msg)})`));
                }
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function main() {
    console.log('Seeding NOSTR feed with test posts...\n');

    for (const artist of artists) {
        console.log(`--- ${artist.name} ---`);
        const sk = hexToBytes(artist.privateKeyHex);

        // Space notes out over the past few weeks so they have varied timestamps
        const now = Math.floor(Date.now() / 1000);
        const noteCount = artist.notes.length;

        for (let i = 0; i < noteCount; i++) {
            // Spread from ~3 weeks ago to recent, oldest first
            const hoursAgo = Math.floor((noteCount - 1 - i) * (21 * 24) / noteCount);
            const jitter = Math.floor(Math.random() * 3600); // random hour jitter
            const timestamp = now - (hoursAgo * 3600) - jitter;

            const event = finalizeEvent({
                kind: 1,
                created_at: timestamp,
                tags: [['app', 'Equaliser']],
                content: artist.notes[i]
            }, sk);

            try {
                await publishEvent(event);
                console.log(`  ✓ "${artist.notes[i].substring(0, 50)}..."`);
            } catch (err) {
                console.log(`  ✗ Failed: ${err.message} | Event kind: ${event.kind}, id: ${event.id?.substring(0,16)}`);
            }
        }
        console.log('');
    }

    console.log('Done! Feed seeded with test posts.');
}

main().catch(console.error);
