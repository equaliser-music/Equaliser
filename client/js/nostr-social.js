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

    // Standard relays from server config (fetched on init via /api/config)
    // Falls back to empty if not configured (localhost dev = local relay only)
    let FALLBACK_RELAYS = [];
    let _fallbacksLoaded = false;
    let _relaysLoaded = false;

    /**
     * Fetch standard relays from server config endpoint.
     * Called once on app init before loadUserRelays.
     */
    async function loadServerConfig() {
        if (_fallbacksLoaded) return;
        _fallbacksLoaded = true;
        try {
            const resp = await fetch('/api/config');
            if (resp.ok) {
                const config = await resp.json();
                if (config.standard_relays && config.standard_relays.length > 0) {
                    FALLBACK_RELAYS = config.standard_relays;
                }
            }
        } catch (e) {
            // Config unavailable — stay with local relay only
        }
    }

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
        const path = url.split('?')[0].split('#')[0].toLowerCase();
        // Standard image extensions
        if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(path)) return true;
        // Blossom URLs: /blossom/{sha256hash} — 64-char hex hash, no extension
        if (/\/blossom\/[a-f0-9]{64}$/.test(path)) return true;
        return false;
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

        const allEvents = _deduplicateEvents(allResults);
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
        const events = _deduplicateEvents(allResults);
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

    // ===== Follow List Modal =====

    /**
     * Show a modal listing followers or following for a pubkey.
     * @param {string} pubkey - hex pubkey
     * @param {'following'|'followers'} type
     * @param {Function} [onToggleFollow] - callback(targetPubkey, isNowFollowing) after follow/unfollow
     */
    async function showFollowListModal(pubkey, type, onToggleFollow) {
        // Remove existing modal
        const existing = document.getElementById('follow-list-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'follow-list-modal';
        modal.className = 'follow-list-modal open';
        modal.innerHTML = `
            <div class="follow-list-modal-content">
                <div class="follow-list-modal-header">
                    <h3>${type === 'following' ? 'Following' : 'Followers'}</h3>
                    <button class="follow-list-modal-close" id="follow-list-close">&times;</button>
                </div>
                <div class="follow-list-modal-body" id="follow-list-body">
                    <div style="padding:24px;text-align:center;color:rgba(255,255,255,0.4);">Loading...</div>
                </div>
            </div>`;
        document.body.appendChild(modal);

        // Close handlers
        const close = () => modal.remove();
        document.getElementById('follow-list-close').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };

        try {
            let pubkeys = [];

            if (type === 'following') {
                // Get the user's Kind 3 contact list
                let events;
                if (typeof CacheAPI !== 'undefined') {
                    events = await CacheAPI.queryEvents({ kinds: [3], authors: [pubkey], limit: 1 });
                } else {
                    events = await queryRelays({ kinds: [3], authors: [pubkey], limit: 1 });
                }
                if (events && events.length > 0) {
                    pubkeys = events[0].tags.filter(t => t[0] === 'p').map(t => t[1]);
                }
            } else {
                // Get Kind 3 events that tag this pubkey
                let events;
                if (typeof CacheAPI !== 'undefined') {
                    events = await CacheAPI.queryEvents({ kinds: [3], '#p': [pubkey], limit: 500 });
                } else {
                    events = await queryRelays({ kinds: [3], '#p': [pubkey], limit: 500 });
                }
                if (events) {
                    const unique = new Map();
                    for (const ev of events) {
                        const ex = unique.get(ev.pubkey);
                        if (!ex || ev.created_at > ex.created_at) unique.set(ev.pubkey, ev);
                    }
                    pubkeys = Array.from(unique.keys());
                }
            }

            if (pubkeys.length === 0) {
                document.getElementById('follow-list-body').innerHTML = `
                    <div style="padding:32px;text-align:center;color:rgba(255,255,255,0.4);">
                        ${type === 'following' ? 'Not following anyone yet' : 'No followers yet'}
                    </div>`;
                return;
            }

            // Fetch profiles with bios — try CacheAPI first for about field
            const profileMap = new Map();
            if (typeof CacheAPI !== 'undefined') {
                try {
                    const cached = await CacheAPI.getProfiles(pubkeys);
                    if (cached) {
                        for (const [pk, p] of Object.entries(cached)) {
                            profileMap.set(pk, {
                                name: p.name || '',
                                picture: p.picture || '',
                                about: p.about || '',
                                nip05: p.nip05 || ''
                            });
                        }
                    }
                } catch (e) {}
            }

            // Fallback for missing profiles
            const missing = pubkeys.filter(pk => !profileMap.has(pk));
            if (missing.length > 0) {
                const fetched = await fetchProfiles(missing);
                fetched.forEach((p, pk) => {
                    if (!profileMap.has(pk)) {
                        profileMap.set(pk, { name: p.name || '', picture: p.picture || '', about: '', nip05: '' });
                    }
                });
            }

            // Get current user's follow list for follow/unfollow buttons
            const session = SessionManager.getSession();
            let myFollowing = new Set();
            if (session) {
                const myContact = (typeof CacheAPI !== 'undefined')
                    ? await CacheAPI.queryEvents({ kinds: [3], authors: [session.publicKey], limit: 1 })
                    : await queryRelays({ kinds: [3], authors: [session.publicKey], limit: 1 });
                if (myContact && myContact.length > 0) {
                    myContact[0].tags.filter(t => t[0] === 'p').forEach(t => myFollowing.add(t[1]));
                }
            }

            // Render list
            const body = document.getElementById('follow-list-body');
            if (!body) return;

            body.innerHTML = pubkeys.map(pk => {
                const p = profileMap.get(pk) || {};
                const name = p.name || 'Unknown';
                const initial = name.charAt(0).toUpperCase();
                let npub = '';
                try { npub = window.NostrTools.nip19.npubEncode(pk); } catch (e) {}
                const bio = p.about ? escapeHtml(p.about.substring(0, 50)) + (p.about.length > 50 ? '...' : '') : '';
                const isMe = session && session.publicKey === pk;
                const isFollowing = myFollowing.has(pk);

                return `
                    <div class="follow-list-item" data-pubkey="${pk}">
                        <a href="/user.html?npub=${npub}" class="follow-list-avatar" onclick="document.getElementById('follow-list-modal').remove()">
                            ${p.picture
                                ? `<img src="${escapeHtml(p.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                : initial}
                        </a>
                        <div class="follow-list-info">
                            <a href="/user.html?npub=${npub}" class="follow-list-name" onclick="document.getElementById('follow-list-modal').remove()">${escapeHtml(name)}</a>
                            ${bio ? `<div class="follow-list-bio">${bio}</div>` : ''}
                        </div>
                        ${!isMe && session ? `
                            <button class="follow-list-btn ${isFollowing ? 'following' : ''}" data-target="${pk}" onclick="NostrSocial._toggleFollowInModal(this, '${pk}')">
                                ${isFollowing ? 'Following' : 'Follow'}
                            </button>` : ''}
                    </div>`;
            }).join('');

        } catch (err) {
            console.error('Failed to load follow list:', err);
            const body = document.getElementById('follow-list-body');
            if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:rgba(255,255,255,0.4);">Failed to load</div>`;
        }
    }

    /**
     * Toggle follow/unfollow from within the modal.
     */
    async function _toggleFollowInModal(btn, targetPubkey) {
        const session = SessionManager.getSession();
        if (!session) return;
        btn.disabled = true;

        try {
            // Fetch current contact list
            let contactEvents;
            if (typeof CacheAPI !== 'undefined') {
                contactEvents = await CacheAPI.queryEvents({ kinds: [3], authors: [session.publicKey], limit: 1 });
            } else {
                contactEvents = await queryRelays({ kinds: [3], authors: [session.publicKey], limit: 1 });
            }

            let tags = [['app', 'Equaliser']];
            if (contactEvents && contactEvents.length > 0) {
                tags = contactEvents[0].tags.filter(t => t[0] !== 'app');
                tags.push(['app', 'Equaliser']);
            }

            const isFollowing = tags.some(t => t[0] === 'p' && t[1] === targetPubkey);
            if (isFollowing) {
                tags = tags.filter(t => !(t[0] === 'p' && t[1] === targetPubkey));
            } else {
                tags.push(['p', targetPubkey]);
            }

            const event = {
                kind: 3,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: ''
            };

            const signedEvent = await SessionManager.signEvent(event);
            await publishEvent(signedEvent);

            const nowFollowing = !isFollowing;
            btn.className = `follow-list-btn ${nowFollowing ? 'following' : ''}`;
            btn.textContent = nowFollowing ? 'Following' : 'Follow';
        } catch (err) {
            console.error('Follow toggle failed:', err);
        } finally {
            btn.disabled = false;
        }
    }

    // ===== Release Announcement Cards =====

    /**
     * Generate a collapsed release announcement card for a note with content-type: release-announcement.
     */
    function generateReleaseAnnouncementCard(note) {
        const isRelease = note.tags?.some(t => t[0] === 'content-type' && t[1] === 'release-announcement');
        if (!isRelease) return '';

        const eventIds = note.tags.filter(t => t[0] === 'e').map(t => t[1]);
        if (eventIds.length === 0) return '';

        const cardId = `release-card-${note.id.substring(0, 8)}`;
        const hasSession = typeof SessionManager !== 'undefined' && SessionManager.hasSession();

        return `
            <div class="feed-playlist-card feed-release-card" id="${cardId}" data-eids='${JSON.stringify(eventIds)}' onclick="expandReleaseCard('${cardId}')">
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20" style="opacity:0.6;flex-shrink:0"><path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/></svg>
                <span>New Release</span>
                <svg class="feed-playlist-chevron" width="16" height="16" fill="currentColor" viewBox="0 0 20 20" style="opacity:0.4;margin-left:auto;transition:transform 0.2s"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
            </div>`;
    }

    /**
     * Expand a release announcement card to show track list.
     */
    async function expandReleaseCard(cardId) {
        const card = document.getElementById(cardId);
        if (!card || card.dataset.expanded === 'true') return;
        card.dataset.expanded = 'true';
        card.onclick = null;

        const eventIds = JSON.parse(card.dataset.eids || '[]');
        const chevron = card.querySelector('.feed-playlist-chevron');
        if (chevron) chevron.style.transform = 'rotate(180deg)';

        const trackListId = `${cardId}-tracks`;
        card.insertAdjacentHTML('afterend', `<div class="feed-playlist-tracklist" id="${trackListId}"><div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">Loading tracks...</div></div>`);

        try {
            const tracks = await NostrPlaylists.resolveTrackEvents(eventIds);
            if (!tracks || tracks.length === 0) {
                document.getElementById(trackListId).innerHTML = `<div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">Could not load tracks</div>`;
                return;
            }

            card._resolvedTracks = tracks;

            // Update card label with release info
            const nameSpan = card.querySelector('span');
            if (nameSpan) {
                const firstTrack = tracks[0];
                const albumName = firstTrack.album || firstTrack.title;
                nameSpan.textContent = tracks.length === 1 ? firstTrack.title : albumName;
            }

            const hasSession = typeof SessionManager !== 'undefined' && SessionManager.hasSession();
            const trackListHtml = tracks.map((t, i) => {
                const duration = t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, '0')}` : '';
                const coverHtml = t.blossomCoverUrl
                    ? `<img src="${escapeHtml(t.blossomCoverUrl)}" alt="" onerror="this.style.display='none'">`
                    : (t.coverArtCid ? `<img src="/ipfs/${t.coverArtCid}" alt="" onerror="this.style.display='none'">` : '');
                return `
                    <div class="feed-playlist-track" onclick="event.stopPropagation(); playFromReleaseCard('${cardId}', ${i})">
                        <div class="feed-playlist-track-cover">${coverHtml}</div>
                        <div class="feed-playlist-track-info">
                            <div class="feed-playlist-track-title">${escapeHtml(t.title)}</div>
                            <div class="feed-playlist-track-artist">${escapeHtml(t.artist || 'Unknown Artist')}</div>
                        </div>
                        <div class="feed-playlist-track-duration">${duration}</div>
                        <svg class="feed-playlist-track-play" width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 3.5v13l10-6.5z"/></svg>
                    </div>`;
            }).join('');

            document.getElementById(trackListId).innerHTML = `
                <div class="feed-playlist-actions">
                    <button class="feed-playlist-play-all" onclick="event.stopPropagation(); playFromReleaseCard('${cardId}', 0)">
                        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 3.5v13l10-6.5z"/></svg>
                        Play All
                    </button>
                    <span class="feed-playlist-count">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</span>
                    ${hasSession ? `<button class="add-to-library-btn" onclick="event.stopPropagation(); addReleaseToLibrary('${cardId}', this)">+ Add to Library</button>` : ''}
                </div>
                ${trackListHtml}`;

            // Toggle collapse on card header click
            card.onclick = () => {
                const el = document.getElementById(trackListId);
                if (!el) return;
                const hidden = el.style.display === 'none';
                el.style.display = hidden ? '' : 'none';
                if (chevron) chevron.style.transform = hidden ? 'rotate(180deg)' : '';
            };
        } catch (err) {
            console.error('Failed to load release tracks:', err);
            document.getElementById(trackListId).innerHTML = `<div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">Failed to load tracks</div>`;
        }
    }

    /**
     * Play tracks from a release announcement card.
     */
    function playFromReleaseCard(cardId, index) {
        const card = document.getElementById(cardId);
        if (!card || !card._resolvedTracks) return;
        const playerTracks = card._resolvedTracks.map(t => ({
            title: t.title,
            artist: t.artist || 'Unknown Artist',
            previewCid: t.previewCid,
            manifestCid: t.manifestCid,
            blossomCoverUrl: t.blossomCoverUrl,
            blossomCoverHash: t.blossomCoverHash,
            coverArtCid: t.coverArtCid,
            duration: t.duration
        }));
        EqualiserPlayer.setPlaylist(playerTracks, index);
    }

    /**
     * Add a release's tracks to the user's library as a new playlist.
     */
    async function addReleaseToLibrary(cardId, btn) {
        const card = document.getElementById(cardId);
        if (!card || !card._resolvedTracks) return;
        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

        try {
            const tracks = card._resolvedTracks;
            const eventIds = tracks.map(t => t.eventId);
            const firstTrack = tracks[0];
            const title = tracks.length === 1
                ? firstTrack.title
                : (firstTrack.album || firstTrack.artist + ' — Release');

            await NostrPlaylists.createPlaylist(title, eventIds);

            if (btn) { btn.textContent = 'Added'; btn.className = 'add-to-library-btn added'; }
        } catch (err) {
            console.error('Failed to add to library:', err);
            if (btn) { btn.disabled = false; btn.textContent = '+ Add to Library'; }
        }
    }

    /**
     * Follow a playlist and add it to the user's library.
     */
    async function addPlaylistToLibrary(pubkey, dTag, btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

        try {
            await NostrPlaylists.followPlaylist(pubkey, dTag);
            if (btn) { btn.textContent = 'Added'; btn.className = 'add-to-library-btn added'; }
        } catch (err) {
            console.error('Failed to add playlist to library:', err);
            if (btn) { btn.disabled = false; btn.textContent = '+ Add to Library'; }
        }
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
        loadServerConfig,
        queryRelays,
        publishToLocal,
        fetchFromLocal,
        showFollowListModal,
        _toggleFollowInModal,
        generateReleaseAnnouncementCard,
        expandReleaseCard,
        playFromReleaseCard,
        addReleaseToLibrary,
        addPlaylistToLibrary
    };
})();
