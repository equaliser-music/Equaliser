/**
 * NostrSocial — shared NOSTR social functions for Equaliser client pages.
 *
 * Provides relay communication, note/profile/reaction fetching,
 * event publishing, and utility functions.
 *
 * Depends on: SessionManager (session.js)
 */
const NostrSocial = (() => {
    // Relay configuration
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const LOCAL_RELAY = `${wsProtocol}//${window.location.host}/relay`;
    const DEFAULT_RELAYS = [LOCAL_RELAY];

    // ===== Utilities =====

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function relativeTime(unixTimestamp) {
        const now = Math.floor(Date.now() / 1000);
        const diff = now - unixTimestamp;
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
        if (diff < 2592000) return `${Math.floor(diff / 604800)}w`;
        const date = new Date(unixTimestamp * 1000);
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }

    function linkifyContent(text) {
        return text.replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
        );
    }

    // ===== Low-level relay communication =====

    function _queryRelay(relayUrl, filter, timeoutMs = 8000) {
        return new Promise((resolve) => {
            const ws = new WebSocket(relayUrl);
            const events = [];
            const timeout = setTimeout(() => {
                try { ws.close(); } catch (e) {}
                resolve(events);
            }, timeoutMs);

            ws.onopen = () => {
                const subId = 'ns-' + Math.random().toString(36).substring(7);
                ws.send(JSON.stringify(['REQ', subId, filter]));
            };

            ws.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'EVENT' && data[2]) events.push(data[2]);
                    if (data[0] === 'EOSE') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(events);
                    }
                } catch (err) {}
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                resolve(events);
            };
        });
    }

    function _publishToSingleRelay(relayUrl, event) {
        return new Promise((resolve) => {
            const ws = new WebSocket(relayUrl);
            const timeout = setTimeout(() => {
                try { ws.close(); } catch (e) {}
                resolve(false);
            }, 5000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['EVENT', event]));
            };

            ws.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'OK') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(data[2] === true);
                    }
                } catch (err) {}
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                resolve(false);
            };
        });
    }

    function _deduplicateEvents(resultsArrays) {
        const seen = new Set();
        const all = [];
        for (const events of resultsArrays) {
            for (const ev of events) {
                if (!seen.has(ev.id)) {
                    seen.add(ev.id);
                    all.push(ev);
                }
            }
        }
        return all;
    }

    // ===== Public API =====

    /**
     * Fetch notes from all relays with a given filter. Deduplicates and sorts newest-first.
     */
    async function fetchNotes(filter) {
        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, filter))
        );
        const notes = _deduplicateEvents(allResults);
        notes.sort((a, b) => b.created_at - a.created_at);
        return notes;
    }

    /**
     * Fetch Kind 0 profiles for a list of pubkeys. Returns Map<pubkey, {name, picture, nip05}>.
     */
    async function fetchProfiles(pubkeys) {
        if (pubkeys.length === 0) return new Map();

        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [0],
                authors: pubkeys,
                limit: pubkeys.length
            }, 6000))
        );

        const profiles = new Map();
        for (const events of allResults) {
            for (const ev of events) {
                try {
                    const existing = profiles.get(ev.pubkey);
                    if (!existing || ev.created_at > existing.created_at) {
                        const p = JSON.parse(ev.content);
                        profiles.set(ev.pubkey, {
                            name: p.display_name || p.name || '',
                            picture: p.picture || '',
                            nip05: p.nip05 || '',
                            created_at: ev.created_at
                        });
                    }
                } catch (err) {}
            }
        }
        return profiles;
    }

    /**
     * Fetch the followed pubkeys for the current logged-in user (from Kind 3 contact list).
     * Returns array of hex pubkey strings, or empty array if not logged in.
     */
    async function fetchContactList(pubkeyHex) {
        if (!pubkeyHex) {
            const session = SessionManager.getSession();
            if (!session) return [];
            pubkeyHex = session.publicKey;
        }

        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [3],
                authors: [pubkeyHex],
                limit: 1
            }, 5000))
        );

        // Find the most recent contact list event
        let best = null;
        for (const events of allResults) {
            for (const ev of events) {
                if (!best || ev.created_at > best.created_at) best = ev;
            }
        }

        if (!best) return [];
        return best.tags
            .filter(t => t[0] === 'p' && t[1])
            .map(t => t[1]);
    }

    /**
     * Fetch Kind 7 (likes) and Kind 6 (reposts) for a list of note IDs.
     * Returns { likes: {noteId: count}, reposts: {noteId: count}, userLiked: Set, userReposted: Set }
     */
    async function fetchReactions(noteIds) {
        if (noteIds.length === 0) {
            return { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
        }

        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [7, 6],
                '#e': noteIds,
                limit: 500
            }, 6000))
        );

        const allEvents = _deduplicateEvents(allResults);

        const likes = {};
        const reposts = {};
        const session = SessionManager.getSession();
        const userPubkey = session ? session.publicKey : null;
        const userLiked = new Set();
        const userReposted = new Set();

        allEvents.forEach(ev => {
            const eTag = ev.tags.find(t => t[0] === 'e');
            if (!eTag) return;
            const noteId = eTag[1];

            if (ev.kind === 7 && ev.content !== '-') {
                likes[noteId] = (likes[noteId] || 0) + 1;
                if (ev.pubkey === userPubkey) userLiked.add(noteId);
            } else if (ev.kind === 6) {
                reposts[noteId] = (reposts[noteId] || 0) + 1;
                if (ev.pubkey === userPubkey) userReposted.add(noteId);
            }
        });

        return { likes, reposts, userLiked, userReposted };
    }

    /**
     * Publish a signed event to all DEFAULT_RELAYS. Throws if all relays reject.
     */
    async function publishEvent(event) {
        const results = await Promise.all(
            DEFAULT_RELAYS.map(r => _publishToSingleRelay(r, event))
        );
        if (!results.some(r => r)) {
            throw new Error('Failed to publish to any relay');
        }
    }

    // ===== Expose public API =====

    return {
        DEFAULT_RELAYS,
        escapeHtml,
        relativeTime,
        linkifyContent,
        fetchNotes,
        fetchProfiles,
        fetchContactList,
        fetchReactions,
        publishEvent
    };
})();
