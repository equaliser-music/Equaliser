/**
 * Centralized Session Management — used by BOTH admin and client surfaces.
 *
 * Mounted at /common/js/session.js by nginx so the same file serves /admin/* and /.
 * Surface-specific behaviours key on `window.EQ_SURFACE`:
 *   - 'admin'  → role fetched via /api/auth/whoami after login (Phase C+)
 *   - undefined (default = client/listener) → no role fetch; auto-registers with cache
 *
 * Both surfaces share sessionStorage key `equaliser_session` (same origin), so the
 * same nsec carries across surfaces in the same tab.
 *
 * Security:
 * - nsec sessions: private key in sessionStorage (tab-scoped, cleared on tab close)
 * - extension sessions: only public key stored, signing delegated to NIP-07 extension
 * - Session cleared on tab close, idle timeout, or explicit logout
 * - authFetch adds NIP-98 `payload` tag (SHA256 of body) for POST/PUT/PATCH — server
 *   verifies if present (anti-MITM body-swap protection)
 */

const SessionManager = {
    // Session state
    _session: null,
    _idleTimeout: 30 * 60 * 1000, // 30 minutes
    _lastActivity: null,
    _idleCheckInterval: null,
    _broadcastChannel: null,
    _storageKey: 'equaliser_session',

    // Role state (populated by fetchRole() — see Node Management Phase C)
    _role: null,                  // 'artist' | 'label' | 'operator'
    _managedArtists: [],          // hex pubkeys this user can manage
    _selectedArtistPubkey: null,  // currently active artist context (label/operator)
    _rolePromise: null,           // in-flight fetchRole() promise

    /**
     * Initialize the session manager
     * Call this on page load
     */
    init() {
        this._lastActivity = Date.now();
        this._restoreSession();
        this._setupActivityTracking();
        this._setupIdleCheck();
        this._setupBroadcastChannel();
    },

    /**
     * Check if a session exists
     */
    hasSession() {
        return this._session !== null && this._session.publicKey !== null;
    },

    /**
     * Check if NIP-07 extension is available
     */
    hasExtension() {
        return typeof window.nostr !== 'undefined';
    },

    /**
     * Create session from nsec (manual login)
     * @param {string} nsec - The NOSTR private key (nsec1...)
     * @returns {object} Session object with publicKey, npub, sign function
     */
    async createSessionFromNsec(nsec) {
        // Decode the nsec
        const decoded = NostrTools.nip19.decode(nsec);

        if (decoded.type !== 'nsec') {
            throw new Error('Invalid format. Expected nsec1...');
        }

        const privateKey = decoded.data;
        const publicKey = NostrTools.getPublicKey(privateKey);
        const npub = NostrTools.nip19.npubEncode(publicKey);

        // Create session with signing capability
        this._session = {
            type: 'nsec',
            privateKey: privateKey,
            publicKey: publicKey,
            npub: npub,
            createdAt: Date.now(),

            // Sign function that uses the private key
            sign: async (event) => {
                return NostrTools.finalizeEvent(event, privateKey);
            }
        };

        this._lastActivity = Date.now();
        this._persistSession(nsec);
        this._broadcastSessionChange('login');
        this._registerWithCache(publicKey);

        return this.getSession();
    },

    /**
     * Create session from NIP-07 extension
     * @returns {object} Session object with publicKey, npub, sign function
     */
    async createSessionFromExtension() {
        if (!this.hasExtension()) {
            throw new Error('No NOSTR extension found. Please install Alby, nos2x, or another NIP-07 extension.');
        }

        try {
            const publicKey = await window.nostr.getPublicKey();
            const npub = NostrTools.nip19.npubEncode(publicKey);

            // Create session that delegates signing to extension
            this._session = {
                type: 'extension',
                privateKey: null, // Extension manages the key
                publicKey: publicKey,
                npub: npub,
                createdAt: Date.now(),

                // Sign function that uses the extension
                sign: async (event) => {
                    return await window.nostr.signEvent(event);
                }
            };

            this._lastActivity = Date.now();
            this._persistSession(null);
            this._broadcastSessionChange('login');
            this._registerWithCache(publicKey);

            return this.getSession();
        } catch (error) {
            throw new Error('Extension rejected the request: ' + error.message);
        }
    },

    /**
     * Fetch the authenticated user's role from the orchestrator.
     *
     * Populates _role, _managedArtists from /api/auth/whoami (NIP-98 auth).
     * Also sets _selectedArtistPubkey to the first managed artist if not already set.
     * Safe to call multiple times — deduplicates in-flight requests via _rolePromise.
     *
     * @returns {Promise<{role: string, managedArtists: string[]}>}
     */
    async fetchRole() {
        if (!this._session) {
            throw new Error('No active session');
        }
        if (this._rolePromise) return this._rolePromise;

        this._rolePromise = (async () => {
            try {
                const resp = await this.authFetch('/api/auth/whoami');

                // Strict mode: 403 with reason=no_role_on_node means this pubkey has no
                // node_artists/node_operators row. Redirect to /admin/redeem.html so the
                // user can enter an invite code. (Only on the admin surface; only when not
                // already on a public/auth page to avoid redirect loops.)
                if (resp.status === 403 && this._isAdminSurface()) {
                    let reason = null;
                    try {
                        const err = await resp.json();
                        reason = (err.detail && err.detail.reason) || err.detail;
                    } catch (e) { /* ignore */ }
                    if (reason === 'no_role_on_node' && !this._isOnAuthPage()) {
                        const here = window.location.pathname.split('/').pop() || 'dashboard.html';
                        window.location.href = '/admin/redeem.html?return=' + encodeURIComponent(here);
                        // Block further code from running while the navigation completes
                        return new Promise(() => {});
                    }
                }

                if (!resp.ok) {
                    throw new Error(`whoami HTTP ${resp.status}`);
                }
                const data = await resp.json();
                this._role = data.role || 'artist';
                this._managedArtists = Array.isArray(data.managed_artists) ? data.managed_artists : [];

                // Default selected artist: self if in managed list, else first managed, else self
                if (!this._selectedArtistPubkey || !this._managedArtists.includes(this._selectedArtistPubkey)) {
                    if (this._managedArtists.includes(this._session.publicKey)) {
                        this._selectedArtistPubkey = this._session.publicKey;
                    } else if (this._managedArtists.length > 0) {
                        this._selectedArtistPubkey = this._managedArtists[0];
                    } else {
                        this._selectedArtistPubkey = this._session.publicKey;
                    }
                }

                this._persistRole();
                return { role: this._role, managedArtists: this._managedArtists };
            } catch (e) {
                // Network failure or non-403 error — keep cached role if any, otherwise
                // be conservative: don't fabricate a role on the admin surface (the
                // strict gate is the source of truth). On the client surface, listener
                // mode is the natural fallback (no role state needed).
                if (this._isAdminSurface()) {
                    console.warn('fetchRole failed on admin surface:', e.message);
                } else {
                    this._role = 'listener';
                    this._managedArtists = [];
                }
                return { role: this._role, managedArtists: this._managedArtists };
            } finally {
                this._rolePromise = null;
            }
        })();

        return this._rolePromise;
    },

    /**
     * Get the current role. May be null if fetchRole() hasn't completed yet.
     */
    getRole() {
        return this._role;
    },

    /**
     * Are we running on the admin surface? Pages opt in via `<script>window.EQ_SURFACE = 'admin';</script>`
     * before session.js loads. The /admin/* path is also treated as admin even if the flag is missing
     * (defensive — covers any HTML that forgot the opt-in).
     */
    _isAdminSurface() {
        return window.EQ_SURFACE === 'admin' || window.location.pathname.startsWith('/admin');
    },

    /**
     * Are we already on a public auth page where the redeem-redirect would loop?
     */
    _isOnAuthPage() {
        const path = window.location.pathname;
        return path.includes('/redeem.html')
            || path.includes('/setup.html')
            || path.includes('/login.html')
            || path.includes('/onboarding.html')
            || path === '/join'
            || path.endsWith('/join.html');
    },

    /**
     * Get the list of artist pubkeys the current user can manage.
     */
    getManagedArtists() {
        return [...this._managedArtists];
    },

    /**
     * Get the currently selected artist pubkey (for labels/operators who manage
     * multiple artists). Artists always have themselves selected.
     */
    getSelectedArtistPubkey() {
        return this._selectedArtistPubkey || (this._session ? this._session.publicKey : null);
    },

    /**
     * Change the currently selected artist. Broadcasts to other tabs.
     * Only valid for pubkeys in managedArtists.
     */
    setSelectedArtistPubkey(pubkey) {
        if (!this._managedArtists.includes(pubkey)) {
            throw new Error('Cannot select unmanaged artist');
        }
        this._selectedArtistPubkey = pubkey;
        this._persistRole();
        if (this._broadcastChannel) {
            this._broadcastChannel.postMessage({ type: 'artist-switch', pubkey });
        }
    },

    /**
     * Get current session (safe copy without private key)
     * @returns {object|null} Session info or null if not logged in
     */
    getSession() {
        if (!this._session) return null;

        return {
            type: this._session.type,
            publicKey: this._session.publicKey,
            npub: this._session.npub,
            createdAt: this._session.createdAt,
            sign: this._session.sign
        };
    },

    /**
     * Get the private key (use with caution)
     * Only available for nsec sessions, not extension sessions
     */
    getPrivateKey() {
        if (!this._session || this._session.type !== 'nsec') {
            return null;
        }
        return this._session.privateKey;
    },

    /**
     * Sign an event using the session
     * Auto-adds ['app', 'Equaliser'] tag if not already present.
     * @param {object} event - Unsigned NOSTR event
     * @returns {object} Signed event
     */
    async signEvent(event) {
        if (!this._session) {
            throw new Error('No active session');
        }
        // Auto-tag all Equaliser events before signing
        event.tags = event.tags || [];
        if (!event.tags.some(t => t[0] === 'app' && t[1] === 'Equaliser')) {
            event.tags.push(['app', 'Equaliser']);
        }
        return await this._session.sign(event);
    },

    /**
     * Clear the session and logout
     */
    logout() {
        this._clearSession();
        this._broadcastSessionChange('logout');
    },

    /**
     * Require session - redirect to login if not authenticated
     * @param {string} returnUrl - URL to return to after login (optional)
     */
    requireSession(returnUrl) {
        if (!this.hasSession()) {
            const currentUrl = returnUrl || window.location.href;
            const loginUrl = this._getLoginUrl(currentUrl);
            window.location.href = loginUrl;
            return false;
        }
        return true;
    },

    /**
     * Get session duration in milliseconds
     */
    getSessionDuration() {
        if (!this._session) return 0;
        return Date.now() - this._session.createdAt;
    },

    /**
     * Format session duration for display
     */
    getFormattedDuration() {
        const duration = this.getSessionDuration();
        const minutes = Math.floor(duration / 60000);

        if (minutes < 60) {
            return `${minutes}m`;
        }

        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    },

    /**
     * Record user activity (resets idle timer)
     */
    recordActivity() {
        this._lastActivity = Date.now();
        // Update last activity in storage
        this._updateStoredActivity();
    },

    /**
     * Create a NIP-98 Authorization header for an API request.
     * Signs a Kind 27235 event containing the URL and HTTP method.
     * If body is provided, also adds a `payload` tag (SHA256 hex of body)
     * — server verifies if present (anti-MITM body-swap protection).
     * @param {string} url - The full request URL
     * @param {string} method - The HTTP method (GET, POST, etc.)
     * @param {string|undefined} body - Optional request body for payload tag
     * @returns {string} Authorization header value ("Nostr <base64>")
     */
    async createNip98Auth(url, method, body) {
        if (!this._session) {
            throw new Error('No active session');
        }

        const tags = [
            ['u', url],
            ['method', method.toUpperCase()]
        ];

        if (body && typeof body === 'string' && body.length > 0) {
            const hash = await this._sha256Hex(body);
            tags.push(['payload', hash]);
        }

        const event = {
            kind: 27235,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: ''
        };

        const signed = await this.signEvent(event);
        return 'Nostr ' + btoa(JSON.stringify(signed));
    },

    /**
     * SHA-256 of a UTF-8 string, returned as lowercase hex.
     */
    async _sha256Hex(s) {
        const bytes = new TextEncoder().encode(s);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    /**
     * Fetch wrapper that automatically adds NIP-98 auth headers.
     * Use this for all authenticated API calls.
     * @param {string} url - The request URL (relative or absolute)
     * @param {object} options - Standard fetch options
     * @returns {Promise<Response>} The fetch response
     */
    async authFetch(url, options = {}) {
        const fullUrl = new URL(url, window.location.origin).href;
        const method = (options.method || 'GET').toUpperCase();
        const body = typeof options.body === 'string' ? options.body : undefined;
        const authHeader = await this.createNip98Auth(fullUrl, method, body);
        options.headers = { ...options.headers, 'Authorization': authHeader };
        return fetch(url, options);
    },

    /**
     * Listener-side: register pubkey with the orchestrator's user-cache. Best-effort.
     * Skipped on the admin surface (admin pages don't need cache registration —
     * artists/labels/operators are tracked in node_artists/node_operators instead).
     */
    _registerWithCache(pubkey) {
        if (window.EQ_SURFACE === 'admin') return;
        fetch('/api/users/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey })
        }).catch(() => { /* silent */ });
    },

    // ==================== Private Methods ====================

    /**
     * Persist session to sessionStorage
     */
    _persistSession(nsec) {
        const data = {
            type: this._session.type,
            publicKey: this._session.publicKey,
            npub: this._session.npub,
            createdAt: this._session.createdAt,
            lastActivity: this._lastActivity,
            role: this._role,
            managedArtists: this._managedArtists,
            selectedArtistPubkey: this._selectedArtistPubkey
        };

        // For nsec sessions, store the nsec (sessionStorage is tab-scoped and cleared on close)
        if (nsec) {
            data.nsec = nsec;
        }

        try {
            sessionStorage.setItem(this._storageKey, JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to persist session:', e);
        }
    },

    /**
     * Persist only the role-related fields without touching session keys.
     */
    _persistRole() {
        try {
            const stored = sessionStorage.getItem(this._storageKey);
            if (!stored) return;
            const data = JSON.parse(stored);
            data.role = this._role;
            data.managedArtists = this._managedArtists;
            data.selectedArtistPubkey = this._selectedArtistPubkey;
            sessionStorage.setItem(this._storageKey, JSON.stringify(data));
        } catch (e) {
            // Ignore errors
        }
    },

    /**
     * Update last activity timestamp in storage
     */
    _updateStoredActivity() {
        try {
            const stored = sessionStorage.getItem(this._storageKey);
            if (stored) {
                const data = JSON.parse(stored);
                data.lastActivity = this._lastActivity;
                sessionStorage.setItem(this._storageKey, JSON.stringify(data));
            }
        } catch (e) {
            // Ignore errors
        }
    },

    /**
     * Restore session from sessionStorage
     */
    _restoreSession() {
        try {
            const stored = sessionStorage.getItem(this._storageKey);
            if (!stored) return;

            const data = JSON.parse(stored);

            // Check if session has expired due to inactivity
            const idleTime = Date.now() - (data.lastActivity || data.createdAt);
            if (idleTime >= this._idleTimeout) {
                console.log('Stored session expired due to inactivity');
                sessionStorage.removeItem(this._storageKey);
                return;
            }

            // Restore cached role state (if present). fetchRole() will refresh from server.
            if (data.role) this._role = data.role;
            if (Array.isArray(data.managedArtists)) this._managedArtists = data.managedArtists;
            if (data.selectedArtistPubkey) this._selectedArtistPubkey = data.selectedArtistPubkey;

            // Restore based on session type
            if (data.type === 'nsec' && data.nsec) {
                // Restore nsec session
                const decoded = NostrTools.nip19.decode(data.nsec);
                const privateKey = decoded.data;

                this._session = {
                    type: 'nsec',
                    privateKey: privateKey,
                    publicKey: data.publicKey,
                    npub: data.npub,
                    createdAt: data.createdAt,
                    sign: async (event) => {
                        return NostrTools.finalizeEvent(event, privateKey);
                    }
                };

                this._lastActivity = data.lastActivity || Date.now();

            } else if (data.type === 'extension') {
                // For extension sessions, we need to verify the extension is still available
                // and re-create the signing function
                if (this.hasExtension()) {
                    this._session = {
                        type: 'extension',
                        privateKey: null,
                        publicKey: data.publicKey,
                        npub: data.npub,
                        createdAt: data.createdAt,
                        sign: async (event) => {
                            return await window.nostr.signEvent(event);
                        }
                    };

                    this._lastActivity = data.lastActivity || Date.now();
                } else {
                    // Extension not available, clear stored session
                    console.log('Extension not available, clearing session');
                    sessionStorage.removeItem(this._storageKey);
                }
            }
        } catch (e) {
            console.warn('Failed to restore session:', e);
            sessionStorage.removeItem(this._storageKey);
        }
    },

    /**
     * Clear session from memory and storage
     */
    _clearSession() {
        if (this._session && this._session.privateKey) {
            // Overwrite sensitive data before releasing
            this._session.privateKey = null;
        }
        this._session = null;
        this._role = null;
        this._managedArtists = [];
        this._selectedArtistPubkey = null;
        this._rolePromise = null;

        // Clear from sessionStorage
        try {
            sessionStorage.removeItem(this._storageKey);
        } catch (e) {
            // Ignore errors
        }

        // Clear idle check interval
        if (this._idleCheckInterval) {
            clearInterval(this._idleCheckInterval);
            this._idleCheckInterval = null;
        }
    },

    /**
     * Get login page URL with return parameter
     */
    _getLoginUrl(returnUrl) {
        const baseUrl = window.location.pathname.replace(/\/[^\/]*$/, '/login.html');
        if (returnUrl) {
            return `${baseUrl}?return=${encodeURIComponent(returnUrl)}`;
        }
        return baseUrl;
    },

    /**
     * Setup activity tracking (mouse, keyboard, scroll)
     */
    _setupActivityTracking() {
        const recordActivity = () => this.recordActivity();

        document.addEventListener('mousemove', recordActivity, { passive: true });
        document.addEventListener('mousedown', recordActivity, { passive: true });
        document.addEventListener('keydown', recordActivity, { passive: true });
        document.addEventListener('scroll', recordActivity, { passive: true });
        document.addEventListener('touchstart', recordActivity, { passive: true });
    },

    /**
     * Check if audio/video is playing
     */
    _isMediaPlaying() {
        const mediaElements = document.querySelectorAll('audio, video');
        for (const media of mediaElements) {
            if (!media.paused && !media.ended) {
                return true;
            }
        }
        return false;
    },

    /**
     * Setup idle timeout checking
     */
    _setupIdleCheck() {
        this._idleCheckInterval = setInterval(() => {
            if (!this.hasSession()) return;

            const idleTime = Date.now() - this._lastActivity;

            // Don't timeout if media is playing
            if (this._isMediaPlaying()) {
                this._lastActivity = Date.now();
                this._updateStoredActivity();
                return;
            }

            if (idleTime >= this._idleTimeout) {
                console.log('Session expired due to inactivity');
                this.logout();

                // Redirect to login with message
                const loginUrl = this._getLoginUrl(window.location.href);
                window.location.href = loginUrl + '&expired=1';
            }
        }, 60000); // Check every minute
    },

    /**
     * Setup BroadcastChannel for multi-tab sync
     */
    _setupBroadcastChannel() {
        try {
            this._broadcastChannel = new BroadcastChannel('equaliser_session');

            this._broadcastChannel.onmessage = (event) => {
                if (event.data.type === 'logout') {
                    // Another tab logged out - clear our session too
                    this._clearSession();
                    window.location.href = this._getLoginUrl();
                } else if (event.data.type === 'artist-switch' && event.data.pubkey) {
                    // Another tab switched the selected artist — mirror the change
                    if (this._managedArtists.includes(event.data.pubkey)) {
                        this._selectedArtistPubkey = event.data.pubkey;
                        this._persistRole();
                        window.dispatchEvent(new CustomEvent('equaliser:artist-switched', {
                            detail: { pubkey: event.data.pubkey }
                        }));
                    }
                }
            };
        } catch (e) {
            // BroadcastChannel not supported - fall back to storage events
            window.addEventListener('storage', (event) => {
                if (event.key === 'equaliser_logout_signal') {
                    this._clearSession();
                    window.location.href = this._getLoginUrl();
                }
            });
        }
    },

    /**
     * Broadcast session change to other tabs
     */
    _broadcastSessionChange(action) {
        if (this._broadcastChannel) {
            this._broadcastChannel.postMessage({ type: action });
        } else {
            // Fallback for browsers without BroadcastChannel
            if (action === 'logout') {
                localStorage.setItem('equaliser_logout_signal', Date.now().toString());
                localStorage.removeItem('equaliser_logout_signal');
            }
        }
    }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionManager;
}
