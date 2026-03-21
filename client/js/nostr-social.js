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

    // Well-known public relays used as fallback when user has no Kind 10002
    const FALLBACK_RELAYS = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net'
    ];
    let _relaysLoaded = false;

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

    /**
     * Extract URLs from plain text (before escaping).
     */
    function _extractUrls(text) {
        const matches = text.match(/https?:\/\/[^\s<]+/g);
        return matches || [];
    }

    /**
     * Extract YouTube video ID from a URL.
     * Supports youtube.com/watch, youtu.be, youtube.com/shorts, youtube.com/embed
     */
    function _getYouTubeId(url) {
        const patterns = [
            /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
        ];
        for (const p of patterns) {
            const m = url.match(p);
            if (m) return m[1];
        }
        return null;
    }

    /**
     * Check if a URL points to an image file.
     */
    function _isImageUrl(url) {
        // Strip query string and fragment for extension check
        const path = url.split('?')[0].split('#')[0].toLowerCase();
        return /\.(jpg|jpeg|png|gif|webp|svg)$/.test(path);
    }

    /**
     * Generate link preview HTML for URLs found in note content.
     * Returns HTML string to append after the note content.
     * Supports: inline images, YouTube thumbnails.
     */
    function generateLinkPreviews(rawText) {
        const urls = _extractUrls(rawText);
        if (urls.length === 0) return '';

        const previews = [];
        const seen = new Set();

        for (const url of urls) {
            if (seen.has(url)) continue;
            seen.add(url);

            // Inline image
            if (_isImageUrl(url)) {
                previews.push(`
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="link-preview link-preview-inline-image" onclick="event.stopPropagation()">
                        <img src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'">
                    </a>`);
                continue;
            }

            // YouTube preview
            const ytId = _getYouTubeId(url);
            if (ytId && !seen.has('yt:' + ytId)) {
                seen.add('yt:' + ytId);
                const thumb = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
                previews.push(`
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="link-preview" onclick="event.stopPropagation()">
                        <div class="link-preview-image">
                            <img src="${thumb}" alt="" loading="lazy">
                            <div class="link-preview-play">
                                <svg width="36" height="36" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                            </div>
                        </div>
                        <div class="link-preview-meta">
                            <span class="link-preview-domain">youtube.com</span>
                        </div>
                    </a>`);
                continue;
            }
        }

        return previews.join('');
    }

    // ===== Low-level relay communication =====

    async function _queryRelay(relayUrl, filter, timeoutMs = 8000) {
        // When cache API is available, the local relay has all data (synced from
        // standard relays). Skip external relay WebSocket queries entirely.
        if (typeof CacheAPI !== 'undefined') {
            if (relayUrl === LOCAL_RELAY) {
                try {
                    const events = await CacheAPI.queryEvents(filter);
                    if (events !== null) return events;
                } catch (err) {
                    // Cache API unavailable — fall through to WebSocket
                }
            } else {
                // External relay — skip it, local relay has the data
                return [];
            }
        }

        // WebSocket fallback (cache API unavailable or failed)
        return _queryRelayWS(relayUrl, filter, timeoutMs);
    }

    function _queryRelayWS(relayUrl, filter, timeoutMs = 8000) {
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
     * Tries cache API first, falls back to WebSocket for any pubkeys not in cache.
     */
    async function fetchProfiles(pubkeys) {
        if (pubkeys.length === 0) return new Map();

        const profiles = new Map();
        let missingPubkeys = pubkeys;

        // Try cache API first
        if (typeof CacheAPI !== 'undefined') {
            try {
                const cached = await CacheAPI.getProfiles(pubkeys);
                if (cached) {
                    for (const [pk, p] of Object.entries(cached)) {
                        profiles.set(pk, {
                            name: p.name || '',
                            picture: p.picture || '',
                            nip05: p.nip05 || '',
                            created_at: p.created_at || 0
                        });
                    }
                    missingPubkeys = pubkeys.filter(pk => !cached[pk]);
                }
            } catch (err) {
                // Cache unavailable — fall through to WebSocket
            }
        }

        // WebSocket fallback for any pubkeys not in cache
        if (missingPubkeys.length > 0) {
            const allResults = await Promise.all(
                DEFAULT_RELAYS.map(r => _queryRelay(r, {
                    kinds: [0],
                    authors: missingPubkeys,
                    limit: missingPubkeys.length
                }, 6000))
            );

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
        }

        return profiles;
    }

    /**
     * Fetch the followed pubkeys for the current logged-in user (from Kind 3 contact list).
     * Returns array of hex pubkey strings, or empty array if not logged in.
     * Tries cache API first, falls back to WebSocket.
     */
    async function fetchContactList(pubkeyHex) {
        if (!pubkeyHex) {
            const session = SessionManager.getSession();
            if (!session) return [];
            pubkeyHex = session.publicKey;
        }

        // Try cache API first
        if (typeof CacheAPI !== 'undefined') {
            try {
                const cached = await CacheAPI.getUserFollows(pubkeyHex);
                if (cached && cached.length > 0) return cached;
            } catch (err) {
                // Cache unavailable — fall through to WebSocket
            }
        }

        // WebSocket fallback
        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [3],
                authors: [pubkeyHex],
                limit: 1
            }, 5000))
        );

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
     * Check if an event has the Equaliser app tag.
     */
    function isEqualiiserEvent(event) {
        return event.tags && event.tags.some(t => t[0] === 'app' && t[1] === 'Equaliser');
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

    // ===== Threading & Replies =====

    /**
     * Check if an event is a top-level feed post (not a reply, not a community thread/reply).
     * Events without a content-type tag are treated as feed posts (backward compat).
     */
    function isTopLevelPost(event) {
        const contentType = event.tags?.find(t => t[0] === 'content-type');
        if (contentType && (contentType[1] === 'thread' || contentType[1] === 'reply')) {
            return false;
        }
        const hasReplyMarker = event.tags?.some(t =>
            t[0] === 'e' && (t[3] === 'root' || t[3] === 'reply')
        );
        return !hasReplyMarker;
    }

    /**
     * Parse NIP-10 threading tags from an event.
     * Returns { root, reply, mentions, profiles }.
     */
    function parseThreadTags(event) {
        let root = null;
        let reply = null;
        const mentions = [];
        const profiles = [];

        for (const tag of (event.tags || [])) {
            if (tag[0] === 'e') {
                if (tag[3] === 'root') root = tag[1];
                else if (tag[3] === 'reply') reply = tag[1];
                else if (tag[3] === 'mention') mentions.push(tag[1]);
            }
            if (tag[0] === 'p') {
                profiles.push(tag[1]);
            }
        }
        return { root, reply, mentions, profiles };
    }

    /**
     * Fetch reply counts for a set of note IDs.
     * Returns Map<noteId, replyCount>.
     */
    async function fetchReplyCounts(noteIds) {
        if (noteIds.length === 0) return new Map();

        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [1],
                '#e': noteIds,
                limit: 1000
            }, 8000))
        );

        const allEvents = _deduplicateEvents(allResults)
            .filter(ev => isEqualiiserEvent(ev));
        const counts = new Map();

        for (const ev of allEvents) {
            for (const tag of ev.tags) {
                if (tag[0] === 'e' && (tag[3] === 'root' || tag[3] === 'reply')) {
                    const refId = tag[1];
                    if (noteIds.includes(refId) && tag[3] === 'root') {
                        counts.set(refId, (counts.get(refId) || 0) + 1);
                    }
                }
            }
        }
        return counts;
    }

    /**
     * Fetch a single event by ID.
     */
    async function fetchEventById(eventId) {
        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                ids: [eventId],
                limit: 1
            }, 5000))
        );
        const events = _deduplicateEvents(allResults);
        return events.length > 0 ? events[0] : null;
    }

    /**
     * Fetch thread replies for a root event ID, sorted oldest first.
     */
    async function fetchThreadReplies(rootEventId) {
        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [1],
                '#e': [rootEventId],
                limit: 500
            }, 10000))
        );
        const events = _deduplicateEvents(allResults)
            .filter(ev => isEqualiiserEvent(ev));
        events.sort((a, b) => a.created_at - b.created_at);
        return events;
    }

    // ===== Community =====

    /**
     * Fetch community threads, optionally filtered by board.
     */
    async function fetchCommunityThreads(board, limit = 50) {
        // Relay doesn't index multi-char tags — fetch all Kind 1 and filter client-side
        const allNotes = await fetchNotes({ kinds: [1], limit: 500 });
        let threads = allNotes.filter(ev =>
            isEqualiiserEvent(ev) &&
            ev.tags.some(t => t[0] === 'content-type' && t[1] === 'thread')
        );
        if (board && board !== 'all') {
            threads = threads.filter(ev =>
                ev.tags.some(t => t[0] === 'board' && t[1] === board)
            );
        }
        return threads.slice(0, limit);
    }

    /**
     * Fetch community replies for a thread root ID, sorted oldest first.
     */
    async function fetchCommunityReplies(threadId) {
        // Relay indexes #e (single-letter) but not #content-type — filter client-side
        const allResults = await Promise.all(
            DEFAULT_RELAYS.map(r => _queryRelay(r, {
                kinds: [1],
                '#e': [threadId],
                limit: 500
            }, 10000))
        );
        const events = _deduplicateEvents(allResults)
            .filter(ev =>
                isEqualiiserEvent(ev) &&
                ev.tags.some(t => t[0] === 'content-type' && t[1] === 'reply')
            );
        events.sort((a, b) => a.created_at - b.created_at);
        return events;
    }

    // ===== Relay List Management =====

    /**
     * Load the user's relay list (Kind 10002) and add external relays to DEFAULT_RELAYS.
     * Checks local relay first, then well-known relays, then falls back to defaults.
     * Mirrors Kind 10002 to local relay if found externally.
     */
    async function loadUserRelays(pubkey) {
        if (_relaysLoaded || !pubkey) return;
        _relaysLoaded = true;

        let externalRelays = [];

        // 1. Check local relay for Kind 10002
        const localEvents = await _queryRelay(LOCAL_RELAY, {
            kinds: [10002], authors: [pubkey], limit: 1
        }, 5000);

        if (localEvents.length > 0) {
            externalRelays = localEvents[0].tags
                .filter(t => t[0] === 'r' && t[1])
                .map(t => t[1])
                .filter(url => url !== LOCAL_RELAY);
        } else {
            // 2. No Kind 10002 locally — try well-known relays
            for (const fallback of FALLBACK_RELAYS) {
                try {
                    const fbEvents = await _queryRelay(fallback, {
                        kinds: [10002], authors: [pubkey], limit: 1
                    }, 5000);
                    if (fbEvents.length > 0) {
                        externalRelays = fbEvents[0].tags
                            .filter(t => t[0] === 'r' && t[1])
                            .map(t => t[1])
                            .filter(url => url !== LOCAL_RELAY);
                        // Mirror Kind 10002 to local relay
                        _publishToSingleRelay(LOCAL_RELAY, fbEvents[0]);
                        break;
                    }
                } catch (e) { /* skip failed relay */ }
            }

            // 3. If still nothing, use fallbacks directly
            if (externalRelays.length === 0) {
                externalRelays = FALLBACK_RELAYS.slice();
            }
        }

        // Always include fallback relays as a safety net
        for (const fallback of FALLBACK_RELAYS) {
            if (!externalRelays.includes(fallback)) {
                externalRelays.push(fallback);
            }
        }

        // Cap external relays to avoid slow queries across too many connections
        const MAX_EXTERNAL_RELAYS = 5;
        if (externalRelays.length > MAX_EXTERNAL_RELAYS) {
            externalRelays = externalRelays.slice(0, MAX_EXTERNAL_RELAYS);
        }

        // Push external relays into DEFAULT_RELAYS (mutate array so all references see changes)
        for (const relay of externalRelays) {
            if (!DEFAULT_RELAYS.includes(relay)) {
                DEFAULT_RELAYS.push(relay);
            }
        }

    }

    /**
     * Query all DEFAULT_RELAYS with a filter and return raw events (deduplicated, most recent per pubkey).
     * Unlike fetchProfiles(), this returns full raw events for use by the profile editor.
     */
    async function queryRelays(filter) {
        const allResults = await Promise.allSettled(
            DEFAULT_RELAYS.map(r => _queryRelay(r, filter, 4000))
        ).then(results => results
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value)
        );
        // Deduplicate by pubkey, keeping most recent
        const seen = new Map();
        for (const events of allResults) {
            for (const ev of events) {
                const key = ev.pubkey || ev.id;
                const existing = seen.get(key);
                if (!existing || ev.created_at > existing.created_at) {
                    seen.set(key, ev);
                }
            }
        }
        return Array.from(seen.values());
    }

    /**
     * Publish an already-signed event to the local relay only (for mirroring).
     */
    async function publishToLocal(event) {
        return _publishToSingleRelay(LOCAL_RELAY, event);
    }

    /**
     * Fetch notes from the local relay only. Sorts newest-first.
     */
    async function fetchFromLocal(filter) {
        const events = await _queryRelay(LOCAL_RELAY, filter);
        events.sort((a, b) => b.created_at - a.created_at);
        return events;
    }

    // ===== Expose public API =====

    return {
        DEFAULT_RELAYS,
        LOCAL_RELAY,
        escapeHtml,
        relativeTime,
        linkifyContent,
        generateLinkPreviews,
        isEqualiiserEvent,
        isTopLevelPost,
        parseThreadTags,
        fetchNotes,
        fetchProfiles,
        fetchContactList,
        fetchReactions,
        fetchReplyCounts,
        fetchEventById,
        fetchThreadReplies,
        fetchCommunityThreads,
        fetchCommunityReplies,
        publishEvent,
        loadUserRelays,
        queryRelays,
        publishToLocal,
        fetchFromLocal
    };
})();
