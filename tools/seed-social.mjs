#!/usr/bin/env node
// ⚠️  INTENTIONAL TEST KEYS — NOT A LEAK
// The private keys below are throwaway DEV/TEST personas used only to seed
// demo data on local/test relays. They hold no funds and no real identity.
// Do NOT reuse this pattern for real identities (real keys live in gitignored packages/).
/**
 * Seed NOSTR relay with social content: feed posts, replies, community threads, DMs, reactions.
 * Usage: node tools/seed-social.mjs
 *
 * Requires the content node to be running (./tools/start-node.sh -d).
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { encrypt as nip04Encrypt } from 'nostr-tools/nip04';
import { hexToBytes } from '@noble/hashes/utils';
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost/relay';

// ===== All identities =====

const DECKY = {
    name: 'Decky',
    privateKeyHex: '20829971e0a41618fad320e76928328defd886be652502dd92a705e6de240958',
    publicKeyHex: '483d294225eb94095338ed4d721c50424b9a964986a68bcab75f9c98c7392078',
};

const USERS = [
    { name: 'Maya Chen',      privateKeyHex: 'eaa526d913652c15f65b668fa008d64526e97a6345cb493e6d4b1cbaabbea59f', publicKeyHex: '798ac12221e376182ceb8c00ed231bfbd509b200f99640d54d4ea27629842614' },
    { name: 'Tom Ashworth',   privateKeyHex: '3ece8872f0eb7dea35c3393b55a6d96648591784dcd9d1ec34ee9f8b23efa640', publicKeyHex: '6706d4d86c93329c1215ac9e9db7284613e724c28d0ffd42c80e7f567a9098e4' },
    { name: 'Priya Kapoor',   privateKeyHex: '817fe0884806b429d9a3fd9d66a7818b366fa421bb54c8c32ceb0616d8def945', publicKeyHex: '0341481925291ba9d20f241a6309cb4a749f81253f46b03f42b0205d21bfa225' },
    { name: 'Jake Morrison',  privateKeyHex: '4696faa43e40ac516c3670e9068464cc2b596ae611ab70e26f65e539f560c822', publicKeyHex: 'b74da95a9e0307c330ff9c70722423674ae59dc686f829d960d87a5020283006' },
    { name: 'Suki Tanaka',    privateKeyHex: 'c66e4c43099d156cc98278cfc676a2455674ac00e335d3555c79312a57d1295c', publicKeyHex: '0bc7a37cbf106cac4fde294b32466e181541d8edbefaf10f14a1964b77bfb1c9' },
    { name: 'Marcus Webb',    privateKeyHex: 'd4445f7a4fce570f389b0900380312f7e5e9cc660f9735b5a7ed6443347367a2', publicKeyHex: '516c6246b7eea8e80ec70fa09757aa81be2a7e37cee8f3f40f4746482998987d' },
    { name: 'Ava Okonkwo',    privateKeyHex: 'd80407e229d481ae0535bf4fa41d2707c25208fdb3661d765c9f65e1051f8648', publicKeyHex: 'edb031cc56a5317168cc1915121d6612cb84714f8cb81d81afbdd12d82300daf' },
    { name: 'Dan Kowalski',   privateKeyHex: '5bffebb5342f3c7d0bb181ea96f35334cf85d42983c400bc6cf3d014ddb41040', publicKeyHex: 'c77e2b2f741542da54b5eaff57838ac2f6bc899e61cc00448ebeaab54bc8ed69' },
    { name: 'Lena Vasquez',   privateKeyHex: '7777e864bc33be89b7f18c3b5a80076c46083ac823e45e46cd3aa488949118ee', publicKeyHex: '42ad51196154dcafb281e906671d178ee40ded7bc2fc32fbed23251553674172' },
    { name: 'Ravi Patel',     privateKeyHex: 'f68df7161938900b4006a8ae8e96f75dcbeaddd97fa6442df1826dee16b1308d', publicKeyHex: 'aeb92aa9315935175aafad3da067df2d58641c917ded867a556e8dc44f01faeb' },
];

const ARTISTS = [
    { name: 'Shibuya Crossings',    privateKeyHex: '7e111d3b54eb0829d964d648d5dd0d87bbeeec60bb7fc2b7cb5cafa99d187c5d', publicKeyHex: '31f22f8f74707212547a1f3a8aaa96891b7d817c17098c3384fe4d276fd8cac4' },
    { name: 'Language of Flowers',   privateKeyHex: '15504dbcf0e191f22e4d6f0fff135def1b989a46b0113c35da1e31d6d63356ff', publicKeyHex: '483efd7f36b88ca49711b3622a3e45f11856326626997d67ac62bf366890f763' },
    { name: 'Swansea Sound',         privateKeyHex: '8cfdd8671e77b8dd0509eacb49c399f1b064677c5216f7046b022edc15b7c82f', publicKeyHex: '9557d2704a949723c96cc39e15e0c8aaba49895c5688956759b0bc4fdba28209' },
];

const ALL = [DECKY, ...USERS, ...ARTISTS];

// ===== Helpers =====

const now = Math.floor(Date.now() / 1000);

function hoursAgo(h) { return now - h * 3600; }
function daysAgo(d)  { return now - d * 86400; }
function jitter(secs = 3600) { return Math.floor(Math.random() * secs); }

function findUser(name) {
    return ALL.find(u => u.name === name);
}

function signEvent(user, eventTemplate) {
    const sk = hexToBytes(user.privateKeyHex);
    return finalizeEvent(eventTemplate, sk);
}

async function publishEvent(event) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RELAY_URL);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 5000);

        ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg[0] === 'OK') {
                clearTimeout(timeout);
                ws.close();
                msg[2] ? resolve(msg[1]) : reject(new Error(msg[3] || 'Rejected'));
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

// ===== 1. Feed Posts =====

const FEED_POSTS = [
    // Week 4 (28-22 days ago) — early community forming
    { author: 'Decky', content: 'Welcome to Equaliser! We\'re building something different here — a music platform where artists own their content and fans connect directly. Excited to have you all here.', t: daysAgo(28) + jitter() },
    { author: 'Shibuya Crossings', content: 'We\'re one of the first artists on Equaliser and the experience of uploading our music here feels completely different. No algorithms, no middlemen. Just us and the listeners.', t: daysAgo(27) + jitter() },
    { author: 'Language of Flowers', content: 'Just uploaded our catalogue to Equaliser. The audio quality preservation is remarkable — every detail of the master comes through in the HLS stream.', t: daysAgo(26) + jitter() },
    { author: 'Maya Chen', content: 'Signed up for Equaliser today. Already loving the vibe here — feels like early Bandcamp but with social features built in. Found two new artists in ten minutes.', t: daysAgo(25) + jitter() },
    { author: 'Tom Ashworth', content: 'The audio quality on Equaliser is genuinely impressive. Listening to Language of Flowers on vinyl is great, but the HLS streaming here is crystal clear too.', t: daysAgo(24) + jitter() },
    { author: 'Swansea Sound', content: 'Hello Equaliser! We\'re a three-piece from Swansea making jangly indie pop. Thrilled to be part of this community. First release going up this week.', t: daysAgo(23) + jitter() },
    { author: 'Ravi Patel', content: 'As a developer, the tech behind Equaliser fascinates me. IPFS for content, NOSTR for social, Blossom for originals. Smart architecture.', t: daysAgo(22) + jitter() },

    // Week 3 (21-15 days ago) — community growing
    { author: 'Priya Kapoor', content: 'Working on some new songs this evening. There\'s something about the Mumbai rain that makes melodies flow. Anyone else write better in bad weather?', t: daysAgo(21) + jitter() },
    { author: 'Jake Morrison', content: 'As a sound engineer, I appreciate that Equaliser preserves the original audio files. Too many platforms compress everything to mush.', t: daysAgo(20) + jitter() },
    { author: 'Suki Tanaka', content: 'Just saw Shibuya Crossings live in Shimokitazawa last week! They played some unreleased tracks that sounded incredible. Can\'t wait for the new EP.', t: daysAgo(19) + jitter() },
    { author: 'Marcus Webb', content: 'Running a record shop for 20 years taught me one thing: people want to connect with the artists they love. Equaliser gets that right.', t: daysAgo(18) + jitter() },
    { author: 'Ava Okonkwo', content: 'Started curating a playlist of my favourite Equaliser finds. There\'s something special about discovering music on a platform that respects both artists and fans.', t: daysAgo(17) + jitter() },
    { author: 'Dan Kowalski', content: 'That bass line on Shibuya Crossings\' "Neon Reflections" is something else. Simple but so effective. The mark of great songwriting.', t: daysAgo(16) + jitter() },
    { author: 'Lena Vasquez', content: 'Writing an article about the decentralised music movement. Equaliser is the most interesting platform I\'ve come across. The NOSTR integration is clever.', t: daysAgo(15) + jitter() },
    { author: 'Shibuya Crossings', content: 'Two weeks on Equaliser and we\'ve had more genuine fan interactions than six months on the big platforms. Quality over quantity every time.', t: daysAgo(15) + jitter() },

    // Week 2 (14-8 days ago) — deeper engagement
    { author: 'Decky', content: 'Excited to see the community growing here on Equaliser. So many great music fans discovering independent artists. This is what it\'s all about.', t: daysAgo(14) + jitter() },
    { author: 'Maya Chen', content: 'Just discovered Shibuya Crossings on Equaliser and I can\'t stop listening. That blend of electronic and indie is exactly what I needed today.', t: daysAgo(13) + jitter() },
    { author: 'Tom Ashworth', content: 'Been diving deep into the Equaliser catalogue this week. Language of Flowers is special — "Petals in the Rain" is pure magic on a quiet afternoon.', t: daysAgo(12) + jitter() },
    { author: 'Language of Flowers', content: 'Thank you to everyone who\'s been listening to our tracks on Equaliser. Seeing the play counts tick up from real fans (not bots) means the world to us.', t: daysAgo(11) + jitter() },
    { author: 'Priya Kapoor', content: 'Late night writing session turned into a full demo. The verse melody came from humming along to a Language of Flowers track. Inspiration is everywhere.', t: daysAgo(10) + jitter() },
    { author: 'Jake Morrison', content: 'Spent the morning A/B testing the HLS streams on Equaliser vs other platforms. The difference is noticeable, especially on good headphones.', t: daysAgo(10) + jitter() },
    { author: 'Marcus Webb', content: 'Had a customer in the shop today asking about Equaliser. Word is spreading in the indie music community. This is how good platforms grow — organically.', t: daysAgo(9) + jitter() },
    { author: 'Suki Tanaka', content: 'My limited pressing collection is getting out of hand. But between vinyl and Equaliser streaming, I feel like I\'m supporting artists properly.', t: daysAgo(8) + jitter() },

    // Week 1 (7-1 days ago) — active community
    { author: 'Ava Okonkwo', content: 'New playlist coming soon featuring all the best indie finds on Equaliser this month. Swansea Sound\'s new single is definitely on there.', t: daysAgo(7) + jitter() },
    { author: 'Swansea Sound', content: 'New 7" arriving from the pressing plant next week. Proper indie pop on proper vinyl. We\'ll have details on the Equaliser community board soon.', t: daysAgo(6) + jitter() },
    { author: 'Dan Kowalski', content: 'The community here is incredible. Had a genuine conversation with Shibuya Crossings about their production process. Where else does that happen?', t: daysAgo(5) + jitter() },
    { author: 'Lena Vasquez', content: 'My article on decentralised music platforms is live! Equaliser featured prominently. The response has been amazing — so many people interested in alternatives.', t: daysAgo(4) + jitter() },
    { author: 'Ravi Patel', content: 'Been looking at the NOSTR protocol more deeply. The way Equaliser uses it for both social and music metadata is elegant. Open standards win.', t: daysAgo(4) + jitter() },
    { author: 'Shibuya Crossings', content: 'Studio update: we\'ve been layering field recordings from the Shibuya crossing over synth pads. The new material is taking shape and we\'re really excited about the direction.', t: daysAgo(3) + jitter() },
    { author: 'Maya Chen', content: 'Language of Flowers\' "Petals in the Rain" just hit different on a quiet Sunday afternoon. Pure magic. Third time listening today.', t: daysAgo(2) + jitter() },
    { author: 'Tom Ashworth', content: 'Added three more Swansea Sound tracks to my collection today. Their stuff reminds me of the best Sarah Records releases from the late 80s.', t: daysAgo(2) + jitter() },
    { author: 'Decky', content: 'Just pushed some updates to the platform. Community message boards are now live! Head over to the Community page and start some discussions.', t: daysAgo(1) + jitter() },
    { author: 'Language of Flowers', content: 'Writing new material this week. The Cotswolds are at their most beautiful right now — every walk becomes a melody. New single coming soon.', t: hoursAgo(18) + jitter(1800) },
    { author: 'Jake Morrison', content: 'PSA: if you are serious about music, invest in decent headphones before anything else. You would be amazed what you have been missing on Equaliser streams.', t: hoursAgo(8) + jitter(1800) },
    { author: 'Priya Kapoor', content: 'Mumbai rain + good headphones + new music on Equaliser = perfect evening. Currently on repeat: Shibuya Crossings\' entire catalogue.', t: hoursAgo(4) + jitter(1800) },
];

// ===== 2. Feed Replies =====

const FEED_REPLIES = [
    // Replies reference feed posts by index (0-35)
    // Week 4 replies
    { author: 'Maya Chen', parentIndex: 0, content: 'This is exactly what we need! So tired of algorithms deciding what music I hear. Excited to explore.' },
    { author: 'Tom Ashworth', parentIndex: 1, content: 'Same here! The production quality on your tracks is incredible. Sounds amazing even on laptop speakers.' },
    { author: 'Dan Kowalski', parentIndex: 1, content: 'The bass work on your tracks is phenomenal. Really intricate stuff if you listen closely.' },
    { author: 'Ravi Patel', parentIndex: 6, content: 'Absolutely. The architecture is well thought out. Would love to contribute to the open source side.' },
    { author: 'Decky', parentIndex: 6, content: 'Thanks Ravi! We\'re considering opening parts of the codebase. Stay tuned.' },

    // Week 3 replies
    { author: 'Priya Kapoor', parentIndex: 7, content: 'Rain is the best songwriting companion. Something about the rhythm of it just opens up creativity.' },
    { author: 'Marcus Webb', parentIndex: 7, content: 'I always found thunderstorms particularly inspiring. Something primal about it.' },
    { author: 'Ravi Patel', parentIndex: 8, content: 'The original file preservation is huge. I\'ve been comparing waveforms and the Blossom copies are bit-perfect.' },
    { author: 'Shibuya Crossings', parentIndex: 9, content: 'Thanks for coming to the show, Suki! Those unreleased tracks should be on the EP dropping next month.' },
    { author: 'Jake Morrison', parentIndex: 10, content: 'Exactly. Direct connection between artist and listener with no middleman algorithm deciding what you hear.' },
    { author: 'Lena Vasquez', parentIndex: 10, content: 'I\'d love to interview you for my article! The record shop perspective on music discovery is invaluable.' },
    { author: 'Marcus Webb', parentIndex: 10, content: 'Happy to chat anytime, Lena. Drop me a message.' },
    { author: 'Decky', parentIndex: 13, content: 'Great write-up incoming, I hope! The NOSTR protocol has been a perfect fit for what we\'re building.' },
    { author: 'Ravi Patel', parentIndex: 13, content: 'Happy to help with technical details if you need them for the article. The architecture is really well thought out.' },

    // Week 2 replies
    { author: 'Maya Chen', parentIndex: 17, content: 'Me too! Their whole catalogue is incredible. "Neon Reflections" is my current obsession.' },
    { author: 'Suki Tanaka', parentIndex: 17, content: 'If you like Shibuya Crossings, you should check out their live recordings too. Completely different energy!' },
    { author: 'Language of Flowers', parentIndex: 18, content: 'Tom, that means so much to hear. We put a lot of care into the mastering.' },
    { author: 'Shibuya Crossings', parentIndex: 14, content: 'The genuine connections here are what keep us going. Thanks for being part of this community.' },
    { author: 'Ava Okonkwo', parentIndex: 19, content: 'I had the same reaction! "Petals in the Rain" is one of those songs that stops you in your tracks.' },

    // Week 1 replies
    { author: 'Maya Chen', parentIndex: 24, content: 'Ava, will you share the playlist link when it\'s ready? Your taste is always spot on.' },
    { author: 'Ava Okonkwo', parentIndex: 24, content: 'Absolutely! Should be ready by the weekend. Got about 15 tracks so far.' },
    { author: 'Dan Kowalski', parentIndex: 26, content: 'That\'s so cool! I had a similar conversation with Language of Flowers last week. This community is special.' },
    { author: 'Ravi Patel', parentIndex: 27, content: 'Your article was brilliant, Lena. Shared it with my dev community. Lots of interest in the NOSTR angle.' },
    { author: 'Lena Vasquez', parentIndex: 27, content: 'Thanks Ravi! The response has been overwhelming. People are hungry for alternatives.' },
    { author: 'Maya Chen', parentIndex: 29, content: 'Can\'t wait to hear the new material! Field recordings over synths sounds incredible.' },
    { author: 'Suki Tanaka', parentIndex: 30, content: 'Third time? I\'m on my fifth listen today. It gets better every time.' },
    { author: 'Language of Flowers', parentIndex: 30, content: 'So glad it resonated! That song was written on a particularly grey afternoon in the Cotswolds.' },
    { author: 'Marcus Webb', parentIndex: 31, content: 'Sarah Records comparison is spot on. I\'ve been thinking the exact same thing. Proper indie pop.' },
    { author: 'Tom Ashworth', parentIndex: 33, content: 'Really looking forward to new Language of Flowers. Take your time though — the quality shows when you don\'t rush.' },
];

// ===== 3. Community Threads =====

const COMMUNITY_THREADS = [
    {
        author: 'Decky', board: 'general', subject: 'Welcome to Equaliser Community!',
        content: 'Hey everyone! Welcome to the Equaliser community boards. This is a space for music fans, artists, and anyone interested in decentralised music to connect and discuss. Feel free to introduce yourself and share what you\'re listening to!\n\nA few ground rules:\n- Be respectful and supportive\n- Share your discoveries\n- Support independent artists\n\nLooking forward to great conversations!',
        t: daysAgo(28),
    },
    {
        author: 'Maya Chen', board: 'general', subject: 'What are you listening to right now?',
        content: 'Let\'s share what\'s on rotation! I\'ve been deep into Shibuya Crossings\' latest release. That electronic-indie blend is exactly my vibe. What about you all?',
        t: daysAgo(22),
    },
    {
        author: 'Ava Okonkwo', board: 'music', subject: 'Best independent releases this month',
        content: 'Compiling my monthly roundup of the best independent music. So far I\'ve got:\n\n1. Shibuya Crossings - Neon Reflections EP\n2. Language of Flowers - Petals in the Rain (single)\n3. Swansea Sound - Corporate Indie Band Part 2\n\nWhat else should I be listening to? Drop your recommendations below!',
        t: daysAgo(18),
    },
    {
        author: 'Jake Morrison', board: 'production', subject: 'Home studio setup tips for independent artists',
        content: 'I\'ve been helping a few artists set up home studios lately and thought I\'d share some tips:\n\n- You don\'t need expensive gear to make great music\n- Room treatment matters more than mic quality\n- A decent audio interface (even budget) is essential\n- Learn to use your DAW properly before buying plugins\n\nHappy to answer questions about specific setups!',
        t: daysAgo(15),
    },
    {
        author: 'Dan Kowalski', board: 'production', subject: 'What DAW do you use and why?',
        content: 'Curious what everyone\'s using for production. I\'ve been on Ableton for years but keep hearing great things about Bitwig. For bass recording I still go through a separate signal chain.\n\nWhat\'s your setup?',
        t: daysAgo(11),
    },
    {
        author: 'Swansea Sound', board: 'gigs', subject: 'Upcoming shows — share your gig calendar!',
        content: 'We\'ve got a few dates coming up:\n\n- March 15 — The Moon Club, Cardiff\n- March 22 — Windmill Brixton, London\n- April 5 — Broadcast, Glasgow\n\nAll ages, all welcome. Who else is playing shows? Let\'s support each other and go see some live music!',
        t: daysAgo(8),
    },
    {
        author: 'Lena Vasquez', board: 'music', subject: 'Genre recommendations: what to explore next?',
        content: 'I\'ve been mainly listening to indie pop and electronic music, but want to branch out. What genres or artists should I explore?\n\nParticularly interested in:\n- Anything with interesting production\n- Artists who are pushing boundaries\n- Stuff that doesn\'t fit neatly into one genre',
        t: daysAgo(5),
    },
    {
        author: 'Ravi Patel', board: 'general', subject: 'The future of music distribution',
        content: 'Been thinking a lot about where music distribution is heading. Platforms like Equaliser that use NOSTR and IPFS feel like the natural evolution — artists own their content, fans connect directly, no algorithm gatekeeping.\n\nWhat do you all think? Is decentralised music the future, or will the big platforms always dominate?',
        t: daysAgo(2),
    },
];

// ===== 4. Community Replies =====

const COMMUNITY_REPLIES = [
    // Welcome thread (index 0)
    { author: 'Maya Chen', threadIndex: 0, content: 'Thanks for setting this up, Decky! Great to have a space to chat about music with like-minded people. I\'m Maya, electronic and indie music obsessive from London.', dt: 3600 },
    { author: 'Tom Ashworth', threadIndex: 0, content: 'Tom here. Vinyl collector for 15 years, recently converted to digital streaming too. Excited to be part of this community!', dt: 7200 },
    { author: 'Suki Tanaka', threadIndex: 0, content: 'Hello from Tokyo! So glad to find a music community that actually cares about audio quality and supporting artists. Looking forward to discovering new music here.', dt: 14400 },
    { author: 'Shibuya Crossings', threadIndex: 0, content: 'Amazing to see a community forming around independent music. We\'re proud to be part of Equaliser from the early days!', dt: 28800 },

    // What are you listening to (index 1)
    { author: 'Tom Ashworth', threadIndex: 1, content: 'Swansea Sound on repeat! Their jangly guitar sound takes me right back to the C86 era. Pure joy in musical form.', dt: 3600 },
    { author: 'Dan Kowalski', threadIndex: 1, content: 'Been revisiting some classic post-punk lately alongside the new Shibuya Crossings stuff. The contrast is interesting — you can hear the influence.', dt: 7200 },
    { author: 'Priya Kapoor', threadIndex: 1, content: 'Language of Flowers has been my evening wind-down music all week. So delicate and beautiful. "Violet Hour" is a masterpiece.', dt: 10800 },
    { author: 'Marcus Webb', threadIndex: 1, content: 'A mix of everything! That\'s the joy of a platform like this — no algorithm boxing you into one genre.', dt: 21600 },

    // Best releases (index 2)
    { author: 'Lena Vasquez', threadIndex: 2, content: 'Great list, Ava! I\'d add some of the smaller artists that have been uploading recently. There\'s a real wave of quality independent music right now.', dt: 3600 },
    { author: 'Suki Tanaka', threadIndex: 2, content: 'Seconding the Shibuya Crossings pick. Their live versions are even better if you can catch them — totally different energy from the studio recordings.', dt: 14400 },
    { author: 'Language of Flowers', threadIndex: 2, content: 'Honoured to be on this list alongside such great company! Thank you, Ava.', dt: 28800 },

    // Home studio tips (index 3)
    { author: 'Dan Kowalski', threadIndex: 3, content: 'Agree 100% about room treatment. I spent ages tweaking my bass recording setup and the room was the biggest variable. Some foam panels made a huge difference.', dt: 7200 },
    { author: 'Ravi Patel', threadIndex: 3, content: 'For anyone on a budget, look into DIY acoustic panels. Rockwool insulation in wooden frames works surprisingly well and costs a fraction of commercial panels.', dt: 14400 },
    { author: 'Priya Kapoor', threadIndex: 3, content: 'This is so helpful, Jake! I\'ve been wanting to set up a recording space at home. Would a Focusrite Scarlett 2i2 be a decent starting interface?', dt: 21600 },
    { author: 'Jake Morrison', threadIndex: 3, content: 'Priya — the Scarlett 2i2 is perfect for getting started. Great preamps for the price and the latency is low enough for monitoring. Highly recommended!', dt: 28800 },

    // DAW thread (index 4)
    { author: 'Ravi Patel', threadIndex: 4, content: 'Reaper for me. Incredibly powerful, super lightweight, and the licensing is refreshingly fair. It can do everything the expensive DAWs can do.', dt: 7200 },
    { author: 'Jake Morrison', threadIndex: 4, content: 'Pro Tools for professional work (client sessions), Logic for my own projects. Each has its strengths. The best DAW is the one you know inside out.', dt: 14400 },
    { author: 'Shibuya Crossings', threadIndex: 4, content: 'We use Ableton for live performance and production. The workflow for electronic music is unmatched. Plus the Max for Live integration opens up endless possibilities.', dt: 28800 },

    // Gigs thread (index 5)
    { author: 'Tom Ashworth', threadIndex: 5, content: 'I\'ll definitely try to make the Windmill Brixton show! Love that venue. Always great sound in there.', dt: 7200 },
    { author: 'Marcus Webb', threadIndex: 5, content: 'The Moon Club in Cardiff is a brilliant venue. Small enough to feel intimate but the sound system punches well above its weight.', dt: 14400 },
    { author: 'Maya Chen', threadIndex: 5, content: 'Would love to see some Equaliser artists play London! Happy to help promote shows if anyone needs a hand with social media.', dt: 21600 },

    // Genre recs (index 6)
    { author: 'Ava Okonkwo', threadIndex: 6, content: 'If you want interesting production, check out artists blending field recordings with electronic music. Shibuya Crossings does this brilliantly.', dt: 3600 },
    { author: 'Dan Kowalski', threadIndex: 6, content: 'For genre-bending stuff, I always recommend post-rock. It borrows from everywhere — classical, electronic, ambient, metal — and creates something totally unique.', dt: 14400 },

    // Future of music (index 7)
    { author: 'Lena Vasquez', threadIndex: 7, content: 'Great topic, Ravi. For my article I\'ve been interviewing artists and they all say the same thing: ownership and direct fan connection is what matters most. Equaliser delivers both.', dt: 3600 },
    { author: 'Marcus Webb', threadIndex: 7, content: 'Having run a record shop, I can tell you the industry has been broken for decades. The big platforms just digitised the same problems. This feels genuinely different.', dt: 7200 },
    { author: 'Decky', threadIndex: 7, content: 'The beauty of building on open protocols like NOSTR is that even if Equaliser disappeared tomorrow, your content and connections would survive. That\'s the real revolution.', dt: 14400 },
    { author: 'Jake Morrison', threadIndex: 7, content: 'From a technical standpoint, the combination of IPFS for content delivery and NOSTR for social is elegant. Each protocol does what it\'s best at.', dt: 21600 },
];

// ===== 5. Direct Messages to Decky =====

const DM_CONVERSATIONS = [
    // Users messaging Decky
    {
        partner: 'Maya Chen',
        messages: [
            { from: 'Maya Chen', content: 'Hey Decky! Love what you\'re building with Equaliser. The social features are really coming together.', t: daysAgo(4) },
            { from: 'Decky', content: 'Thanks Maya! Really glad to hear that. We\'re working hard to make it a great experience for music fans.', t: daysAgo(4) + 1800 },
            { from: 'Maya Chen', content: 'Any plans to add playlist features? I\'d love to curate collections of my favourite tracks.', t: daysAgo(3) },
        ]
    },
    {
        partner: 'Tom Ashworth',
        messages: [
            { from: 'Tom Ashworth', content: 'Decky, quick question — is there a way to see which tracks I\'ve listened to most? Some kind of listening history?', t: daysAgo(5) },
            { from: 'Decky', content: 'Not yet but that\'s on the roadmap! We want to add listening stats that the user controls, not the platform.', t: daysAgo(5) + 3600 },
            { from: 'Tom Ashworth', content: 'That\'s the right approach. Privacy-first. Looking forward to it!', t: daysAgo(4) },
        ]
    },
    {
        partner: 'Priya Kapoor',
        messages: [
            { from: 'Priya Kapoor', content: 'Hi Decky! I\'m a singer-songwriter and I\'d love to upload my music to Equaliser. How do I get started as an artist?', t: daysAgo(3) },
            { from: 'Decky', content: 'Hey Priya! You can set up as an artist through the admin panel. Upload your tracks and they\'ll be available on IPFS immediately. Let me know if you need any help!', t: daysAgo(3) + 1800 },
        ]
    },
    {
        partner: 'Jake Morrison',
        messages: [
            { from: 'Jake Morrison', content: 'The Blossom integration for original files is really smart. Do you plan to add lossless streaming options?', t: daysAgo(6) },
            { from: 'Decky', content: 'It\'s something we\'ve discussed! The originals are preserved on Blossom, so lossless streaming is technically feasible. Just need to work out the bandwidth economics.', t: daysAgo(6) + 3600 },
            { from: 'Jake Morrison', content: 'Makes sense. Even the HLS quality right now is excellent. Whatever encoding settings you\'re using, keep them!', t: daysAgo(5) },
        ]
    },
    {
        partner: 'Suki Tanaka',
        messages: [
            { from: 'Suki Tanaka', content: 'Konnichiwa Decky! Great platform. Are there plans to support Japanese language in the interface?', t: daysAgo(3) },
            { from: 'Decky', content: 'Hi Suki! Internationalisation is definitely something we want to do. Japanese would be one of the first languages given our connection to the Tokyo music scene.', t: daysAgo(3) + 7200 },
        ]
    },
    {
        partner: 'Marcus Webb',
        messages: [
            { from: 'Marcus Webb', content: 'Decky, this platform reminds me of the best days of running my record shop. Direct artist-fan connection. No corporate nonsense.', t: daysAgo(4) },
            { from: 'Decky', content: 'That means a lot coming from someone with your experience in the music industry, Marcus. That\'s exactly the vibe we\'re going for.', t: daysAgo(4) + 3600 },
            { from: 'Marcus Webb', content: 'If you ever want to chat about how record shops used to build communities, I\'m all ears. Might be useful for the community features.', t: daysAgo(3) },
        ]
    },
    {
        partner: 'Ava Okonkwo',
        messages: [
            { from: 'Ava Okonkwo', content: 'Hey! I run a music blog and I\'d love to write about Equaliser. Would you be up for an interview?', t: daysAgo(2) },
            { from: 'Decky', content: 'Absolutely! Would love to talk about what we\'re building. Drop me a time that works for you.', t: daysAgo(2) + 3600 },
        ]
    },
    {
        partner: 'Dan Kowalski',
        messages: [
            { from: 'Dan Kowalski', content: 'The audio player on Equaliser is smooth. Any chance of adding a queue feature so I can line up tracks?', t: daysAgo(3) },
            { from: 'Decky', content: 'Good idea! A play queue is on the list. We want to get the core social features solid first, then improve the listening experience.', t: daysAgo(3) + 1800 },
        ]
    },
    {
        partner: 'Lena Vasquez',
        messages: [
            { from: 'Lena Vasquez', content: 'Decky, I\'m writing a piece about decentralised music platforms. Can I quote you on the vision behind Equaliser?', t: daysAgo(2) },
            { from: 'Decky', content: 'Of course! Our vision is simple: artists should own their music and their relationship with fans. No intermediaries, no algorithms deciding who gets heard.', t: daysAgo(2) + 1800 },
            { from: 'Lena Vasquez', content: 'Perfect quote. The article should be out next week. I\'ll share the link here when it\'s published.', t: daysAgo(1) },
        ]
    },
    {
        partner: 'Ravi Patel',
        messages: [
            { from: 'Ravi Patel', content: 'Hey Decky, developer here. The NOSTR + IPFS architecture is really elegant. Are you open to contributors?', t: daysAgo(3) },
            { from: 'Decky', content: 'Always! The whole thing is open source. Check out the GitHub repo and feel free to open PRs. We could especially use help with mobile responsiveness.', t: daysAgo(3) + 3600 },
            { from: 'Ravi Patel', content: 'Brilliant. I\'ll take a look at the codebase this weekend. Really excited to contribute.', t: daysAgo(2) },
        ]
    },

    // Artists messaging Decky
    {
        partner: 'Shibuya Crossings',
        messages: [
            { from: 'Shibuya Crossings', content: 'Hey Decky! Thanks for featuring us on the platform. The response from listeners has been amazing.', t: daysAgo(5) },
            { from: 'Decky', content: 'Your music deserves the spotlight! The listeners love the electronic-indie blend. Any new releases coming soon?', t: daysAgo(5) + 3600 },
            { from: 'Shibuya Crossings', content: 'New EP dropping next month! We\'ll send you an early preview if you\'re interested. Working on something really special with field recordings from the crossing.', t: daysAgo(4) },
        ]
    },
    {
        partner: 'Language of Flowers',
        messages: [
            { from: 'Language of Flowers', content: 'Hi Decky. Just wanted to say thank you for building Equaliser. It feels like a platform that actually cares about the music.', t: daysAgo(3) },
            { from: 'Decky', content: 'That\'s the highest compliment we could get. Your music is beautiful and it deserves a platform that treats it with respect.', t: daysAgo(3) + 7200 },
        ]
    },
    {
        partner: 'Swansea Sound',
        messages: [
            { from: 'Swansea Sound', content: 'Decky! We love Equaliser. Finally a platform that understands indie pop. Can we share our back catalogue here too?', t: daysAgo(4) },
            { from: 'Decky', content: 'Absolutely! Upload as many tracks as you like. The more the merrier. Each release gets its own NOSTR event and the originals are preserved on Blossom.', t: daysAgo(4) + 3600 },
            { from: 'Swansea Sound', content: 'Brilliant. We\'ll get the old 7" singles digitised and uploaded. Proper quality, not those dodgy YouTube rips floating around!', t: daysAgo(3) },
        ]
    },
];

// ===== 6. Reactions (likes) =====

// Will be generated after posts are published (need event IDs)

// ===== Main =====

async function main() {
    console.log('=== Seeding NOSTR relay with social content ===\n');

    // --- 1. Feed Posts ---
    console.log('--- Feed Posts ---');
    const publishedPosts = [];
    for (const post of FEED_POSTS) {
        const user = findUser(post.author);
        if (!user) { console.error(`  Unknown user: ${post.author}`); continue; }
        const event = await publish(user, {
            kind: 1,
            created_at: post.t,
            tags: [['app', 'Equaliser'], ['content-type', 'post']],
            content: post.content,
        });
        publishedPosts.push({ event, author: post.author, user });
        console.log(`  + [${post.author}] "${post.content.substring(0, 60)}..."`);
    }
    console.log(`  Published ${publishedPosts.length} feed posts\n`);

    // --- 2. Feed Replies ---
    console.log('--- Feed Replies ---');
    let replyCount = 0;
    for (const reply of FEED_REPLIES) {
        const user = findUser(reply.author);
        const parent = publishedPosts[reply.parentIndex];
        if (!user || !parent) continue;

        const replyTime = parent.event.created_at + 1800 + jitter(7200);
        const event = await publish(user, {
            kind: 1,
            created_at: replyTime,
            tags: [
                ['app', 'Equaliser'],
                ['content-type', 'post'],
                ['e', parent.event.id, '', 'root'],
                ['p', parent.user.publicKeyHex],
            ],
            content: reply.content,
        });
        replyCount++;
        console.log(`  + [${reply.author}] → "${parent.author}": "${reply.content.substring(0, 50)}..."`);
    }
    console.log(`  Published ${replyCount} feed replies\n`);

    // --- 3. Community Threads ---
    console.log('--- Community Threads ---');
    const publishedThreads = [];
    for (const thread of COMMUNITY_THREADS) {
        const user = findUser(thread.author);
        if (!user) continue;

        const event = await publish(user, {
            kind: 1,
            created_at: thread.t,
            tags: [
                ['app', 'Equaliser'],
                ['content-type', 'thread'],
                ['subject', thread.subject],
                ['board', thread.board],
            ],
            content: thread.content,
        });
        publishedThreads.push({ event, author: thread.author, user, subject: thread.subject });
        console.log(`  + [${thread.board}] "${thread.subject}" by ${thread.author}`);
    }
    console.log(`  Published ${publishedThreads.length} community threads\n`);

    // --- 4. Community Replies ---
    console.log('--- Community Replies ---');
    let communityReplyCount = 0;
    for (const reply of COMMUNITY_REPLIES) {
        const user = findUser(reply.author);
        const thread = publishedThreads[reply.threadIndex];
        if (!user || !thread) continue;

        const replyTime = thread.event.created_at + reply.dt + jitter(1800);
        const event = await publish(user, {
            kind: 1,
            created_at: replyTime,
            tags: [
                ['app', 'Equaliser'],
                ['content-type', 'reply'],
                ['e', thread.event.id, '', 'root'],
                ['p', thread.user.publicKeyHex],
            ],
            content: reply.content,
        });
        communityReplyCount++;
        console.log(`  + [${reply.author}] → "${thread.subject.substring(0, 40)}": "${reply.content.substring(0, 50)}..."`);
    }
    console.log(`  Published ${communityReplyCount} community replies\n`);

    // --- 5. Direct Messages ---
    console.log('--- Direct Messages (NIP-04 encrypted) ---');
    let dmCount = 0;
    for (const convo of DM_CONVERSATIONS) {
        const partner = findUser(convo.partner);
        if (!partner) continue;

        for (const msg of convo.messages) {
            const sender = findUser(msg.from);
            if (!sender) continue;

            const recipientPubkey = msg.from === 'Decky' ? partner.publicKeyHex : DECKY.publicKeyHex;
            const senderSk = hexToBytes(sender.privateKeyHex);

            try {
                const encrypted = await nip04Encrypt(senderSk, recipientPubkey, msg.content);

                const event = signEvent(sender, {
                    kind: 4,
                    created_at: msg.t,
                    tags: [
                        ['app', 'Equaliser'],
                        ['p', recipientPubkey],
                    ],
                    content: encrypted,
                });
                await publishEvent(event);
                dmCount++;
                console.log(`  + [${msg.from} → ${msg.from === 'Decky' ? convo.partner : 'Decky'}] "${msg.content.substring(0, 50)}..."`);
            } catch (err) {
                console.error(`  FAIL DM [${msg.from}]: ${err.message}`);
            }
        }
    }
    console.log(`  Published ${dmCount} encrypted DMs\n`);

    // --- 6. Reactions ---
    console.log('--- Reactions (likes) ---');
    let likeCount = 0;
    // Various users liking various posts
    const likePairs = [
        // [userIndex, postIndex] — spread across 30 days of posts (0-35)
        // Week 4 posts
        [0, 0], [3, 0], [6, 0],           // Decky's welcome post
        [0, 1], [2, 1], [4, 1], [7, 1],   // Shibuya Crossings' first post
        [1, 2], [3, 2], [9, 2],           // Language of Flowers' catalogue post
        [1, 3], [5, 3],                   // Maya's signup post
        [0, 4], [8, 4],                   // Tom's audio quality post
        [0, 5], [3, 5], [7, 5],           // Swansea Sound's hello post
        [0, 6], [1, 6], [4, 6],           // Ravi's tech architecture post
        // Week 3 posts
        [0, 7], [4, 7], [8, 7],           // Priya's songwriting post
        [0, 8], [7, 8], [9, 8],           // Jake's audio quality post
        [0, 9], [2, 9], [5, 9],           // Suki's live show post
        [0, 10], [1, 10], [3, 10],        // Marcus's record shop post
        [0, 12], [3, 12], [5, 12],        // Dan's bass line post
        [0, 13], [2, 13], [4, 13], [9, 13], // Lena's article post
        [0, 14], [1, 14],                 // SC's two weeks on Equaliser
        // Week 2 posts
        [1, 16], [3, 16], [5, 16],        // Decky's community growing
        [1, 17], [4, 17], [7, 17],        // Maya discovers Shibuya
        [0, 19], [2, 19],                 // Language of Flowers' thank you
        [0, 20], [7, 20],                 // Priya's late night writing
        [0, 22], [3, 22], [7, 22],        // Marcus's word spreading
        // Week 1 posts
        [0, 24], [2, 24],                 // Ava's playlist post
        [0, 25], [1, 25], [5, 25],        // Swansea Sound's vinyl post
        [1, 27], [3, 27], [5, 27], [9, 27], // Lena's article live
        [0, 29], [4, 29],                 // SC's studio update
        [1, 30], [4, 30],                 // Maya on Language of Flowers
        [1, 32], [3, 32], [5, 32], [7, 32], // Decky's community boards
        [0, 33], [2, 33],                 // LoF writing new material
    ];

    for (const [userIdx, postIdx] of likePairs) {
        const user = USERS[userIdx];
        const post = publishedPosts[postIdx];
        if (!user || !post) continue;

        await publish(user, {
            kind: 7,
            created_at: post.event.created_at + 600 + jitter(3600),
            tags: [
                ['app', 'Equaliser'],
                ['e', post.event.id],
                ['p', post.user.publicKeyHex],
            ],
            content: '+',
        });
        likeCount++;
    }
    console.log(`  Published ${likeCount} likes\n`);

    // --- Summary ---
    console.log('=== Seeding complete! ===');
    console.log(`  Feed posts:       ${publishedPosts.length}`);
    console.log(`  Feed replies:     ${replyCount}`);
    console.log(`  Community threads: ${publishedThreads.length}`);
    console.log(`  Community replies: ${communityReplyCount}`);
    console.log(`  Direct messages:  ${dmCount}`);
    console.log(`  Reactions:        ${likeCount}`);
    console.log(`\nTotal events: ${publishedPosts.length + replyCount + publishedThreads.length + communityReplyCount + dmCount + likeCount}`);
}

main().catch(console.error);
