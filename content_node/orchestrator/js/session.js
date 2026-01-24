/**
 * Centralized Session Management for Equaliser Admin Pages
 *
 * Provides session storage with:
 * - Single login across all admin pages
 * - Idle timeout with audio-awareness
 * - Multi-tab logout synchronization
 * - NIP-07 browser extension support
 *
 * Security:
 * - For nsec sessions: Private key stored in sessionStorage (tab-scoped, cleared on tab close)
 * - For extension sessions: Only public key stored, signing delegated to extension
 * - Session is automatically cleared on tab close, idle timeout, or explicit logout
 */

const SessionManager = {
    // Session state
    _session: null,
    _idleTimeout: 30 * 60 * 1000, // 30 minutes
    _lastActivity: null,
    _idleCheckInterval: null,
    _broadcastChannel: null,
    _storageKey: 'equaliser_session',

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

            return this.getSession();
        } catch (error) {
            throw new Error('Extension rejected the request: ' + error.message);
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
     * @param {object} event - Unsigned NOSTR event
     * @returns {object} Signed event
     */
    async signEvent(event) {
        if (!this._session) {
            throw new Error('No active session');
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
            lastActivity: this._lastActivity
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
