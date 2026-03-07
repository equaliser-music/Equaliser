/**
 * NostrDM — Direct message encryption/decryption for Equaliser.
 *
 * Tries NIP-44 first, falls back to NIP-04 (Kind 4).
 * Supports both nsec sessions and NIP-07 browser extensions.
 *
 * Depends on: NostrSocial (nostr-social.js), SessionManager (session.js)
 */
const NostrDM = (() => {

    // Detect NIP-44 availability at load time
    let hasNip44 = false;
    try {
        hasNip44 = !!(window.NostrTools && window.NostrTools.nip44 &&
                      typeof window.NostrTools.nip44.encrypt === 'function');
    } catch (e) {}

    /**
     * Encrypt a message for a recipient.
     * Uses NIP-04 (well-tested in browser bundle).
     */
    async function encrypt(privateKeyBytes, recipientPubkey, plaintext) {
        // Extension support
        if (!privateKeyBytes && window.nostr?.nip04?.encrypt) {
            return await window.nostr.nip04.encrypt(recipientPubkey, plaintext);
        }
        if (!privateKeyBytes) throw new Error('No private key available for encryption');
        return await window.NostrTools.nip04.encrypt(privateKeyBytes, recipientPubkey, plaintext);
    }

    /**
     * Decrypt a message from a sender.
     */
    async function decrypt(privateKeyBytes, senderPubkey, ciphertext) {
        // Extension support
        if (!privateKeyBytes && window.nostr?.nip04?.decrypt) {
            return await window.nostr.nip04.decrypt(senderPubkey, ciphertext);
        }
        if (!privateKeyBytes) throw new Error('No private key available for decryption');
        return await window.NostrTools.nip04.decrypt(privateKeyBytes, senderPubkey, ciphertext);
    }

    /**
     * Check if DM capability is available (private key or extension nip04).
     */
    function canDM() {
        const pk = SessionManager.getPrivateKey();
        if (pk) return true;
        if (window.nostr?.nip04?.encrypt && window.nostr?.nip04?.decrypt) return true;
        return false;
    }

    /**
     * Fetch all DM events (Kind 4) for current user — incoming + outgoing.
     */
    async function fetchAllDMs(myPubkey) {
        const [incoming, outgoing] = await Promise.all([
            NostrSocial.fetchNotes({ kinds: [4], '#p': [myPubkey], limit: 500 }),
            NostrSocial.fetchNotes({ kinds: [4], authors: [myPubkey], limit: 500 })
        ]);

        // Deduplicate
        const seen = new Set();
        const all = [];
        for (const ev of [...incoming, ...outgoing]) {
            if (!seen.has(ev.id)) {
                seen.add(ev.id);
                all.push(ev);
            }
        }
        all.sort((a, b) => a.created_at - b.created_at);
        return all;
    }

    /**
     * Group DM events into conversations by partner pubkey.
     * Returns Map<partnerPubkey, { messages: [event], lastMessageTime: number }>
     */
    function groupConversations(events, myPubkey) {
        const conversations = new Map();

        for (const ev of events) {
            let partner;
            if (ev.pubkey === myPubkey) {
                const pTag = ev.tags.find(t => t[0] === 'p');
                partner = pTag ? pTag[1] : null;
            } else {
                partner = ev.pubkey;
            }
            if (!partner) continue;

            if (!conversations.has(partner)) {
                conversations.set(partner, { messages: [], lastMessageTime: 0 });
            }
            const conv = conversations.get(partner);
            conv.messages.push(ev);
            if (ev.created_at > conv.lastMessageTime) {
                conv.lastMessageTime = ev.created_at;
            }
        }
        return conversations;
    }

    /**
     * Send a DM (Kind 4) to a recipient.
     */
    async function sendDM(recipientPubkey, plaintext) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        const privateKey = SessionManager.getPrivateKey();
        const encrypted = await encrypt(privateKey, recipientPubkey, plaintext);

        const event = {
            kind: 4,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['app', 'Equaliser'], ['p', recipientPubkey]],
            content: encrypted
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        return signedEvent;
    }

    return {
        encrypt,
        decrypt,
        canDM,
        fetchAllDMs,
        groupConversations,
        sendDM,
        hasNip44
    };
})();
