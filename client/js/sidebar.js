/**
 * Client Sidebar Component for Equaliser Client Pages
 *
 * Provides a consistent sidebar across all client pages with:
 * - Logo and branding
 * - User profile display (avatar, name) or Guest placeholder
 * - Navigation menu
 * - Session info and auth actions
 *
 * Works in both anonymous and logged-in states.
 *
 * Usage:
 *   1. Include this script after session.js and nostr-tools
 *   2. Call ClientSidebar.init() on page load (after SessionManager.init())
 *   3. The sidebar will be injected into a .sidebar element or created if needed
 */

const ClientSidebar = {
    _container: null,
    _profileFetched: false,

    /**
     * Initialize and render the sidebar
     * Should be called after SessionManager.init()
     */
    init() {
        this._createSidebar();

        if (SessionManager.hasSession()) {
            this._fetchUserProfile();
        }
    },

    /**
     * Create and inject the sidebar HTML
     */
    _createSidebar() {
        // Find or create sidebar container
        this._container = document.querySelector('.sidebar');
        if (!this._container) {
            this._container = document.createElement('div');
            this._container.className = 'sidebar';
            const container = document.querySelector('.container');
            if (container) {
                container.insertBefore(this._container, container.firstChild);
            } else {
                document.body.insertBefore(this._container, document.body.firstChild);
            }
        }

        this._container.innerHTML = this._getSidebarHTML();
        this._injectStyles();
    },

    /**
     * Generate sidebar HTML
     */
    _getSidebarHTML() {
        const isLoggedIn = SessionManager.hasSession();
        const session = isLoggedIn ? SessionManager.getSession() : null;
        const pageName = window.location.pathname.split('/').pop().replace('.html', '') || 'home';
        const currentPage = (pageName === 'feed' || pageName === 'community') ? 'social' : pageName;

        // Profile card
        let profileCard;
        if (isLoggedIn) {
            const shortNpub = session.npub.slice(0, 12) + '...' + session.npub.slice(-4);
            profileCard = `
                <a href="/profile.html" class="user-profile-card" id="sidebar-profile-card">
                    <div class="user-avatar-sidebar" id="sidebar-avatar">
                        <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/>
                        </svg>
                    </div>
                    <div class="user-info-sidebar">
                        <div class="user-name-sidebar" id="sidebar-name">Loading...</div>
                        <div class="user-npub-sidebar" id="sidebar-npub">${shortNpub}</div>
                    </div>
                </a>
            `;
        } else {
            profileCard = `
                <div class="user-profile-card guest">
                    <div class="user-avatar-sidebar guest-avatar">
                        <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/>
                        </svg>
                    </div>
                    <div class="user-info-sidebar">
                        <div class="user-name-sidebar">Guest</div>
                        <div class="user-npub-sidebar">Not signed in</div>
                    </div>
                </div>
            `;
        }

        // Bottom nav (only when logged in)
        let bottomNav = '';
        if (isLoggedIn) {
            bottomNav = `
                <div class="nav-section nav-section-bottom">
                    <a href="/social.html" class="nav-item ${currentPage === 'social' ? 'active' : ''}">
                        <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                        </svg>
                        <span>Social</span>
                    </a>
                    <a href="/profile.html" class="nav-item ${currentPage === 'profile' ? 'active' : ''}">
                        <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/>
                        </svg>
                        <span>Profile</span>
                    </a>
                    <a href="/settings.html" class="nav-item ${currentPage === 'settings' ? 'active' : ''}">
                        <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                        </svg>
                        <span>Settings</span>
                    </a>
                </div>
            `;
        }

        // Footer
        let footer;
        if (isLoggedIn) {
            footer = `
                <div class="sidebar-footer">
                    <button class="logout-btn" onclick="ClientSidebar.logout()">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                        </svg>
                        Log Out
                    </button>
                </div>
            `;
        } else {
            footer = `
                <div class="sidebar-footer">
                    <a href="/onboarding.html" class="sidebar-signup-btn">Sign Up</a>
                    <a href="/login.html" class="sidebar-login-link">Log in</a>
                </div>
            `;
        }

        return `
            <div class="sidebar-logo">
                <a href="/home.html">
                    <img src="/images/equaliser-logo.png" alt="Equaliser">
                </a>
            </div>

            ${profileCard}

            <div class="nav-section">
                <div class="nav-title">Menu</div>
                <a href="/home.html" class="nav-item ${currentPage === 'home' ? 'active' : ''}">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/>
                    </svg>
                    <span>Home</span>
                </a>
                <a href="#" class="nav-item disabled">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/>
                    </svg>
                    <span>Discover</span>
                </a>
                <a href="#" class="nav-item disabled">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                    </svg>
                    <span>Library</span>
                </a>
            </div>

            ${bottomNav}
            ${footer}
        `;
    },

    /**
     * Fetch user profile from relay and update sidebar display
     */
    _fetchUserProfile() {
        if (this._profileFetched) return;
        this._profileFetched = true;

        const session = SessionManager.getSession();
        if (!session) return;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const relayUrl = `${wsProtocol}//${window.location.host}/relay`;

        try {
            const ws = new WebSocket(relayUrl);
            const subId = 'sidebar-profile-' + Math.random().toString(36).substring(7);

            const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} }, 5000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [0],
                    authors: [session.publicKey],
                    limit: 1
                }]));
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                        const profile = JSON.parse(msg[2].content);
                        this.updateUserDisplay(
                            profile.display_name || profile.name,
                            profile.picture
                        );
                    }
                    if (msg[0] === 'EOSE') {
                        clearTimeout(timeout);
                        ws.close();
                    }
                } catch (e) {}
            };

            ws.onerror = () => { clearTimeout(timeout); };
        } catch (e) {
            console.log('Failed to fetch profile for sidebar:', e);
        }
    },

    /**
     * Update user display in sidebar
     */
    updateUserDisplay(name, avatarUrl) {
        const nameEl = document.getElementById('sidebar-name');
        const avatarEl = document.getElementById('sidebar-avatar');

        if (nameEl && name) {
            nameEl.textContent = name;
        }

        if (avatarEl && name) {
            const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            if (avatarUrl) {
                avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${name}" onerror="this.parentElement.textContent='${initials}'">`;
            } else {
                avatarEl.textContent = initials;
            }
        }
    },

    /**
     * Update the active nav item based on current path.
     * Called by the router on navigation.
     */
    updateActiveState(path) {
        if (!this._container) return;
        const pageName = path.split('/').pop().split('?')[0].replace('.html', '') || 'home';
        const currentPage = (pageName === 'feed' || pageName === 'community') ? 'social' : pageName;

        this._container.querySelectorAll('.nav-item').forEach(item => {
            const href = item.getAttribute('href');
            if (!href || href === '#') return;
            const itemPage = href.split('/').pop().replace('.html', '') || 'home';
            item.classList.toggle('active', itemPage === currentPage);
        });
    },

    /**
     * Handle logout
     */
    logout() {
        SessionManager.logout();
        window.location.href = '/home.html';
    },

    /**
     * Inject CSS styles
     */
    _injectStyles() {
        if (document.getElementById('client-sidebar-styles')) return;

        const style = document.createElement('style');
        style.id = 'client-sidebar-styles';
        style.textContent = `
            /* Sidebar Base */
            .sidebar {
                width: 240px;
                background: rgba(15, 15, 25, 0.8);
                backdrop-filter: blur(20px);
                border-right: 1px solid rgba(255, 255, 255, 0.05);
                display: flex;
                flex-direction: column;
                padding: 24px 16px 24px;
                position: fixed;
                height: 100vh;
                overflow-y: auto;
                z-index: 100;
            }

            /* Logo */
            .sidebar .sidebar-logo {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 24px;
                padding: 0 8px;
            }

            .sidebar .sidebar-logo a {
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .sidebar .sidebar-logo img {
                width: 160px;
                height: auto;
            }

            /* User Profile Card */
            .sidebar .user-profile-card {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 14px 12px;
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.05);
                border-radius: 12px;
                margin-bottom: 24px;
                text-decoration: none;
                color: inherit;
                transition: all 0.2s;
            }

            .sidebar .user-profile-card:not(.guest):hover {
                background: rgba(255, 255, 255, 0.06);
                border-color: rgba(255, 255, 255, 0.1);
            }

            .sidebar .user-avatar-sidebar {
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: linear-gradient(135deg, #8b5cf6, #a855f7);
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 14px;
                flex-shrink: 0;
                overflow: hidden;
                color: rgba(255, 255, 255, 0.9);
            }

            .sidebar .user-avatar-sidebar img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .sidebar .guest-avatar {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.4);
            }

            .sidebar .user-info-sidebar {
                flex: 1;
                min-width: 0;
            }

            .sidebar .user-name-sidebar {
                font-weight: 600;
                font-size: 14px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: #ffffff;
            }

            .sidebar .user-npub-sidebar {
                font-size: 11px;
                color: rgba(255, 255, 255, 0.4);
                font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* Navigation */
            .sidebar .nav-section {
                margin-bottom: 24px;
            }

            .sidebar .nav-title {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 1px;
                color: rgba(255, 255, 255, 0.4);
                margin-bottom: 12px;
                padding: 0 12px;
                font-weight: 600;
            }

            .sidebar .nav-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
                color: rgba(255, 255, 255, 0.7);
                margin-bottom: 4px;
                text-decoration: none;
            }

            .sidebar .nav-item:hover {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
            }

            .sidebar .nav-item.active {
                background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(168, 85, 247, 0.15));
                color: #ffffff;
            }

            .sidebar .nav-item.disabled {
                opacity: 0.4;
                cursor: default;
                pointer-events: none;
            }

            .sidebar .nav-icon {
                width: 20px;
                height: 20px;
                opacity: 0.8;
            }

            .sidebar .nav-section-bottom {
                margin-top: auto;
                padding-top: 16px;
                border-top: 1px solid rgba(255, 255, 255, 0.05);
            }

            /* Footer */
            .sidebar .sidebar-footer {
                margin-top: auto;
                padding-top: 20px;
                border-top: 1px solid rgba(255, 255, 255, 0.05);
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .sidebar .sidebar-signup-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 11px;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                color: rgba(255, 255, 255, 0.85);
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                transition: all 0.2s;
            }

            .sidebar .sidebar-signup-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.2);
                color: #ffffff;
            }

            .sidebar .sidebar-login-link {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 10px;
                color: rgba(255, 255, 255, 0.45);
                font-size: 13px;
                text-decoration: none;
                transition: color 0.2s;
            }

            .sidebar .sidebar-login-link:hover {
                color: rgba(255, 255, 255, 0.8);
            }

            .sidebar .logout-btn {
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 12px;
                background: rgba(239, 68, 68, 0.1);
                border: 1px solid rgba(239, 68, 68, 0.2);
                border-radius: 10px;
                color: #ef4444;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }

            .sidebar .logout-btn:hover {
                background: rgba(239, 68, 68, 0.2);
                border-color: rgba(239, 68, 68, 0.4);
            }

            .sidebar .logout-btn svg {
                width: 18px;
                height: 18px;
            }

            /* Main content adjustment */
            .main-content {
                margin-left: 240px;
            }

            /* Responsive */
            @media (max-width: 768px) {
                .sidebar {
                    width: 64px;
                    padding: 16px 8px;
                }

                .sidebar .sidebar-logo img {
                    width: 40px;
                }

                .sidebar .user-profile-card {
                    padding: 8px;
                    justify-content: center;
                }

                .sidebar .user-info-sidebar,
                .sidebar .nav-title,
                .sidebar .nav-item span {
                    display: none;
                }

                .sidebar .nav-item {
                    justify-content: center;
                    padding: 12px 8px;
                }

                .sidebar .sidebar-signup-btn {
                    font-size: 11px;
                    padding: 10px 4px;
                }

                .sidebar .sidebar-login-link {
                    font-size: 11px;
                }

                .main-content {
                    margin-left: 64px;
                }
            }
        `;
        document.head.appendChild(style);
    }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClientSidebar;
}
