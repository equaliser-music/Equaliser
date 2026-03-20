/**
 * Cache API client — fetches cached user data from the Equaliser Relay REST API.
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

    return { getProfiles, getUserFollows, getUserFeed };
})();
