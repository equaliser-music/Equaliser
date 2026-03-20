/**
 * Cache API client — fetches data from the Equaliser Relay REST API.
 *
 * Returns null on error or timeout so callers can fall back to WebSocket queries.
 * All endpoints are under /api/cache/ which nginx routes to the relay's REST port.
 */
const CacheAPI = (() => {
    const BASE = '/api/cache';
    const TIMEOUT_MS = 3000;

    async function _fetch(path) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const resp = await fetch(`${BASE}${path}`, { signal: controller.signal });
            clearTimeout(timer);
            if (resp.status === 404) return null;
            if (!resp.ok) return null;
            return await resp.json();
        } catch {
            clearTimeout(timer);
            return null;
        }
    }

    // ===== General Event Query =====

    /**
     * Query events with NIP-01-style filter. Replaces WebSocket REQ for reads.
     * @param {Object} filter - NIP-01 filter: {kinds, authors, ids, '#e', '#p', limit, since, until}
     * @returns {Object[]|null} Array of raw event objects or null
     */
    async function queryEvents(filter) {
        const params = new URLSearchParams();
        if (filter.kinds && filter.kinds.length > 0) params.set('kinds', filter.kinds.join(','));
        if (filter.authors && filter.authors.length > 0) params.set('authors', filter.authors.join(','));
        if (filter.ids && filter.ids.length > 0) params.set('ids', filter.ids.join(','));
        if (filter['#e'] && filter['#e'].length > 0) params.set('e', filter['#e'].join(','));
        if (filter['#p'] && filter['#p'].length > 0) params.set('p', filter['#p'].join(','));
        if (filter.limit) params.set('limit', filter.limit);
        if (filter.since) params.set('since', filter.since);
        if (filter.until) params.set('until', filter.until);

        // Also handle tag filters passed as Tags map (used by nostr-social internally)
        if (filter.tags) {
            if (filter.tags.e && filter.tags.e.length > 0) params.set('e', filter.tags.e.join(','));
            if (filter.tags.p && filter.tags.p.length > 0) params.set('p', filter.tags.p.join(','));
        }

        const qs = params.toString();
        if (!qs) return null;

        const data = await _fetch(`/events?${qs}`);
        return data ? data.events : null;
    }

    // ===== Profile Endpoints =====

    /**
     * Fetch profiles for a batch of pubkeys.
     * @param {string[]} pubkeys - Array of 64-char hex pubkeys
     * @returns {Object|null} Map of pubkey -> {name, picture, nip05, about, created_at, type} or null
     */
    async function getProfiles(pubkeys) {
        if (!pubkeys || pubkeys.length === 0) return null;
        const data = await _fetch(`/profiles?pubkeys=${pubkeys.join(',')}`);
        return data ? data.profiles : null;
    }

    // ===== User Data Endpoints =====

    /**
     * Fetch follow list for a user.
     * @param {string} pubkey - 64-char hex pubkey
     * @returns {string[]|null} Array of followed pubkeys or null
     */
    async function getUserFollows(pubkey) {
        const data = await _fetch(`/users/${pubkey}/follows`);
        return data ? data.follows : null;
    }

    /**
     * Fetch cached feed posts for a user.
     * @param {string} pubkey - 64-char hex pubkey
     * @param {number} [limit=50] - Max events to return
     * @returns {Object[]|null} Array of {event_id, pubkey, content, created_at} or null
     */
    async function getUserFeed(pubkey, limit = 50) {
        const data = await _fetch(`/users/${pubkey}/feed?limit=${limit}`);
        return data ? data.events : null;
    }

    // ===== Artist Endpoints =====

    /**
     * Fetch all artists on this node.
     * @returns {Object[]|null} Array of artist profiles or null
     */
    async function getArtists() {
        const data = await _fetch('/artists');
        return data ? data.artists : null;
    }

    // ===== Track & Album Endpoints =====

    /**
     * Fetch tracks by artist.
     * @param {string} artistPubkey - 64-char hex pubkey
     * @returns {Object[]|null} Array of track objects or null
     */
    async function getTracksByArtist(artistPubkey) {
        const data = await _fetch(`/tracks?artist=${artistPubkey}`);
        return data ? data.tracks : null;
    }

    /**
     * Fetch most recent tracks across all artists.
     * @param {number} [limit=50] - Max tracks to return
     * @returns {Object[]|null} Array of track objects or null
     */
    async function getRecentTracks(limit = 50) {
        const data = await _fetch(`/tracks/recent?limit=${limit}`);
        return data ? data.tracks : null;
    }

    /**
     * Fetch albums by artist.
     * @param {string} artistPubkey - 64-char hex pubkey
     * @returns {Object[]|null} Array of album objects or null
     */
    async function getAlbumsByArtist(artistPubkey) {
        const data = await _fetch(`/albums?artist=${artistPubkey}`);
        return data ? data.albums : null;
    }

    return {
        queryEvents,
        getProfiles,
        getUserFollows,
        getUserFeed,
        getArtists,
        getTracksByArtist,
        getRecentTracks,
        getAlbumsByArtist,
    };
})();
