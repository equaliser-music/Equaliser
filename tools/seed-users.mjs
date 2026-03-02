#!/usr/bin/env node
/**
 * Seed Equaliser with 10 test users.
 *
 * 1. Generates key pairs
 * 2. Publishes Kind 0 profiles with ['app', 'Equaliser'] tag
 * 3. Publishes 5-10 Kind 1 posts per user with ['app', 'Equaliser'] tag
 * 4. Saves backup JSONs to packages/users/
 *
 * Usage:
 *   node tools/seed-users.mjs                          # Against local relay
 *   node tools/seed-users.mjs wss://equaliser.app/relay # Against VPS
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import * as nip19 from 'nostr-tools/nip19';
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(__dirname, '..', 'packages', 'users');
const RELAY_URL = process.argv[2] || 'ws://localhost/relay';

// ===== 10 Test Users =====

const users = [
    {
        name: 'Maya Chen',
        bio: 'Music obsessive. Always hunting for new sounds on Equaliser. Big into electronic and indie.',
        posts: [
            'Just discovered Shibuya Crossings on Equaliser and I cannot stop listening. That blend of electronic and alternative is exactly what I needed today.',
            'The sound quality on Equaliser is genuinely impressive. Streaming Neon Reflections right now and every detail comes through.',
            'Love that Equaliser lets me support artists directly. No middlemen, no algorithms deciding what I hear. Just music.',
            'Language of Flowers new single is beautiful. That crack in the vocals on the bridge? Perfection. Found it through Equaliser.',
            'Spent my Sunday morning exploring new releases on Equaliser. Swansea Sound are such a joy — pure indie pop happiness.',
            'The fact that artists own their content on Equaliser matters. Been in the music industry long enough to know how rare that is.',
        ]
    },
    {
        name: 'Tom Ashworth',
        bio: 'Vinyl collector turned digital. Supporting independent artists on Equaliser.',
        posts: [
            'Swansea Sound on Equaliser remind me of everything I loved about C86. Proper indie pop, no compromises.',
            'Been telling everyone about Equaliser. A platform where artists actually get paid fairly? About time.',
            'Shibuya Crossings live recordings would be incredible. Those late night Tokyo sessions they post about sound magical.',
            'Three months on Equaliser and I have found more new music than in two years on the big platforms.',
            'Language of Flowers writing from a garden in the Cotswolds is the most wholesome thing I have read all week. Their music matches that energy perfectly.',
            'The decentralised approach on Equaliser just makes sense. No single company controlling what music gets heard.',
            'Streaming payments direct to artists. That is how it should always have been. Equaliser gets it right.',
        ]
    },
    {
        name: 'Priya Kapoor',
        bio: 'Singer-songwriter by night, Equaliser listener by day. Mumbai to London.',
        posts: [
            'As a songwriter myself, I appreciate what Equaliser is building. Artists keeping control of their work is everything.',
            'Shibuya Crossings field recordings from the crossing idea is genius. The rhythm of a city as source material — I need to try this.',
            'Followed Language of Flowers on Equaliser. Their songwriting is so honest it hurts in the best way.',
            'The indie pop scene on Equaliser is growing. Swansea Sound leading the charge with that joyful energy.',
            'Love how Equaliser is built on open protocols. No walled gardens, no lock-in. Music should be free to flow.',
            'Just shared my first post on Equaliser. Feels good to be part of a community that values music over metrics.',
        ]
    },
    {
        name: 'Jake Morrison',
        bio: 'Sound engineer. Audiophile. Early adopter. Finding the good stuff on Equaliser.',
        posts: [
            'From an audio engineering perspective, the HLS streaming on Equaliser sounds clean. Proper encoding makes all the difference.',
            'Shibuya Crossings production quality is top tier. Whoever mixed Neon Reflections knows what they are doing.',
            'Equaliser streaming payments mean I know my money goes to the artist. Not some exec in a corner office.',
            'Swansea Sound recording in a shed and it sounds this good? That is the magic of indie. Love finding this on Equaliser.',
            'The more artists join Equaliser the better this gets. Quality over quantity, always.',
        ]
    },
    {
        name: 'Suki Tanaka',
        bio: 'Tokyo-based music lover. Bilingual ears, always listening. Equaliser early supporter.',
        posts: [
            'Shibuya Crossings writing from Tokyo makes me homesick in the best way. That city has a sound and they capture it perfectly.',
            'Finding new artists on Equaliser is like record shopping used to be. Discovery through curiosity, not algorithms.',
            'Language of Flowers and Shibuya Crossings could not be more different but both are brilliant. That is what a good platform offers.',
            'Direct streaming payments on Equaliser mean artists can actually sustain themselves. This is the future of music.',
            'Swansea Sound Corporate Indie Band is the anthem we all needed. Found it on Equaliser and cannot stop playing it.',
            'The community on Equaliser feels real. People who actually care about music, not just content.',
            'Posted my first track recommendation on Equaliser today. Feels different from other platforms — more personal.',
        ]
    },
    {
        name: 'Marcus Webb',
        bio: 'Former record shop owner. Now finding the same magic on Equaliser.',
        posts: [
            'Ran a record shop for fifteen years. Closed it in 2019. Equaliser is the first thing since that feels like real music discovery.',
            'Swansea Sound pressing 500 copies of a seven inch is exactly the kind of thing that keeps indie alive. Supporting them on Equaliser.',
            'Language of Flowers remind me of early Cocteau Twins. Ethereal, beautiful, honest. Glad they mentioned that influence.',
            'The NOSTR protocol underneath Equaliser means no one can take this away. Decentralised music is here to stay.',
            'Shibuya Crossings collaborating with a producer from Osaka sounds incredible. Cross-city electronic music at its finest.',
            'Every stream on Equaliser is a micro-payment to the artist. That is how you build a sustainable music ecosystem.',
        ]
    },
    {
        name: 'Ava Okonkwo',
        bio: 'Playlist curator and music blogger. Building my collection on Equaliser.',
        posts: [
            'Started curating my Equaliser collection today. Shibuya Crossings, Language of Flowers, Swansea Sound — what a foundation.',
            'The thing about Equaliser is the artists here actually want to be here. You can feel that in the music.',
            'Swansea Sound calling themselves the most joyful band in indie pop is accurate. Every track is pure serotonin.',
            'Writing a blog post about decentralised music platforms and Equaliser is leading the conversation. Watch this space.',
            'Language of Flowers leaving that vocal crack in the recording is the kind of artistic decision I live for. Raw and real.',
            'Six months from now everyone will know about Equaliser. Getting in early feels special.',
        ]
    },
    {
        name: 'Dan Kowalski',
        bio: 'Bass player. Coffee drinker. Equaliser listener. Not necessarily in that order.',
        posts: [
            'As a musician, seeing a platform that actually respects artists is refreshing. Equaliser is doing it right.',
            'Shibuya Crossings using field recordings from Tokyo in their tracks is the kind of creativity I am here for.',
            'Swansea Sound playing to thirty people in a tiny venue with no phones out. That is real music. Found them on Equaliser.',
            'Been exploring Equaliser all week. The quality of artists here is remarkable for such an early platform.',
            'Language of Flowers writing about tea, rain and a piano for Sunday songwriting. I feel seen. Great stuff on Equaliser.',
            'Direct payments to artists on Equaliser means every stream counts. No minimum threshold nonsense.',
            'The fact that Equaliser runs on open protocols means any developer can build on it. That is powerful.',
        ]
    },
    {
        name: 'Lena Vasquez',
        bio: 'Music journalist. Covering the decentralised music movement. Equaliser contributor.',
        posts: [
            'Writing a piece on Equaliser for my column. The decentralised approach to music distribution is genuinely innovative.',
            'Interviewed the Shibuya Crossings project last month. Their vision for independent music aligns perfectly with what Equaliser offers.',
            'Swansea Sound are proof that great music does not need a major label. Equaliser gives them the platform they deserve.',
            'The streaming payment model on Equaliser is what I have been advocating for in my writing for years. Finally someone built it.',
            'Language of Flowers headline show in Bristol is sold out. The Equaliser community is showing up for these artists.',
            'Every week I find something new on Equaliser that surprises me. The curation is happening organically through genuine fans.',
        ]
    },
    {
        name: 'Ravi Patel',
        bio: 'Developer by trade, music fan by passion. Equaliser is where both worlds meet.',
        posts: [
            'As a developer, the tech behind Equaliser is fascinating. NOSTR protocol, IPFS storage, direct payments. Elegant stack.',
            'Shibuya Crossings Neon Reflections on repeat while coding. The electronic textures are perfect for deep focus work.',
            'Built a small script to track my listening habits on Equaliser. Open protocols mean I can actually do that. Try doing that on Spotify.',
            'Swansea Sound making me smile on a Monday morning. That is worth more than any algorithm-generated playlist.',
            'Language of Flowers Petals in the Rain is the kind of track you put on and the rest of the world goes quiet. Beautiful work.',
            'The fact that Equaliser is open source means the community drives the roadmap. This is how music platforms should evolve.',
            'Streaming payments, artist ownership, no middlemen. Equaliser is not just a platform, it is a statement.',
        ]
    },
];

// ===== Relay Communication =====

function publishEvent(relayUrl, event) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(relayUrl);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Timeout'));
        }, 8000);

        ws.on('open', () => {
            ws.send(JSON.stringify(['EVENT', event]));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg[0] === 'OK') {
                clearTimeout(timeout);
                ws.close();
                if (msg[2]) {
                    resolve(msg[1]);
                } else {
                    reject(new Error(msg[3] || 'Rejected'));
                }
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// ===== Main =====

async function main() {
    console.log(`Seeding Equaliser with ${users.length} test users`);
    console.log(`Relay: ${RELAY_URL}\n`);

    mkdirSync(BACKUP_DIR, { recursive: true });

    for (const user of users) {
        const privateKey = generateSecretKey();
        const publicKey = getPublicKey(privateKey);
        const nsec = nip19.nsecEncode(privateKey);
        const npub = nip19.npubEncode(publicKey);
        const privateKeyHex = bytesToHex(privateKey);

        console.log(`--- ${user.name} ---`);
        console.log(`  npub: ${npub}`);

        // 1. Publish Kind 0 profile
        const profileContent = {
            name: user.name,
            display_name: user.name,
            about: user.bio,
            picture: '',
            banner: '',
            website: '',
            nip05: '',
            lud16: ''
        };

        const profileEvent = finalizeEvent({
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['app', 'Equaliser']],
            content: JSON.stringify(profileContent)
        }, privateKey);

        try {
            await publishEvent(RELAY_URL, profileEvent);
            console.log('  [ok] Profile published');
        } catch (err) {
            console.log(`  [FAIL] Profile: ${err.message}`);
        }

        // 2. Publish Kind 10002 relay list
        const relayListEvent = finalizeEvent({
            kind: 10002,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['r', 'wss://equaliser.app/relay'],
                ['app', 'Equaliser']
            ],
            content: ''
        }, privateKey);

        try {
            await publishEvent(RELAY_URL, relayListEvent);
            console.log('  [ok] Relay list published');
        } catch (err) {
            console.log(`  [FAIL] Relay list: ${err.message}`);
        }

        // 3. Publish Kind 1 posts with varied timestamps
        const now = Math.floor(Date.now() / 1000);
        const postCount = user.posts.length;

        for (let i = 0; i < postCount; i++) {
            // Spread from ~2 weeks ago to recent
            const hoursAgo = Math.floor((postCount - 1 - i) * (14 * 24) / postCount);
            const jitter = Math.floor(Math.random() * 3600);
            const timestamp = now - (hoursAgo * 3600) - jitter;

            const noteEvent = finalizeEvent({
                kind: 1,
                created_at: timestamp,
                tags: [['app', 'Equaliser']],
                content: user.posts[i]
            }, privateKey);

            try {
                await publishEvent(RELAY_URL, noteEvent);
                console.log(`  [ok] Post ${i + 1}/${postCount}`);
            } catch (err) {
                console.log(`  [FAIL] Post ${i + 1}: ${err.message}`);
            }
        }

        // 4. Save backup JSON
        const backup = {
            version: 1,
            created: new Date().toISOString(),
            keys: {
                nsec,
                npub,
                privateKeyHex,
                publicKeyHex: publicKey
            },
            profile: {
                name: user.name,
                bio: user.bio
            }
        };

        const safeName = user.name.toLowerCase().replace(/\s+/g, '-');
        const backupPath = join(BACKUP_DIR, `equaliser-backup-${safeName}-${Date.now()}.json`);
        writeFileSync(backupPath, JSON.stringify(backup, null, 2));
        console.log(`  [ok] Backup saved: ${backupPath.split('/').pop()}`);
        console.log('');
    }

    console.log('Done! All users seeded.');
}

main().catch(console.error);
