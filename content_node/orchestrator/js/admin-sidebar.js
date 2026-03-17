/**
 * Admin Sidebar Component for Equaliser Admin Pages
 *
 * Provides a consistent sidebar across all admin pages with:
 * - Logo and branding
 * - Artist profile display (avatar, name, status)
 * - Navigation menu
 * - Session info and logout
 *
 * Usage:
 *   1. Include this script after session.js
 *   2. Call AdminSidebar.init() on page load
 *   3. The sidebar will be injected into a .sidebar element or created if needed
 */

const AdminSidebar = {
    _container: null,
    _durationInterval: null,

    /**
     * Initialize and render the sidebar
     * Should be called after SessionManager.init()
     */
    init() {
        if (!SessionManager.hasSession()) {
            return; // Don't show sidebar if not logged in
        }

        this._createSidebar();
        this._startDurationUpdater();
    },

    /**
     * Create and inject the sidebar HTML
     */
    _createSidebar() {
        const session = SessionManager.getSession();
        if (!session) return;

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

        this._container.innerHTML = this._getSidebarHTML(session);
        this._injectStyles();
    },

    /**
     * Generate sidebar HTML
     */
    _getSidebarHTML(session) {
        const shortNpub = session.npub.slice(0, 8) + '...' + session.npub.slice(-4);
        const currentPage = window.location.pathname.split('/').pop().replace('.html', '');
        const sessionType = session.type === 'extension' ? 'Extension' : 'Manual';

        return `
            <div class="logo">
                <div class="logo-main">
                    <img src="/images/equaliser-logo.png" alt="Equaliser">
                </div>
                <span class="logo-subtitle">Artist Admin</span>
            </div>

            <div class="artist-profile" id="sidebar-profile">
                <div class="artist-avatar" id="sidebar-avatar">??</div>
                <div class="artist-info">
                    <div class="artist-name" id="sidebar-name">Loading...</div>
                    <div class="artist-status" id="sidebar-status">Connected</div>
                </div>
            </div>

            <div class="nav-section">
                <div class="nav-title">Manage</div>
                <a href="dashboard.html" class="nav-item ${currentPage === 'dashboard' ? 'active' : ''}">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                    </svg>
                    <span>Dashboard</span>
                </a>
                <a href="releases.html" class="nav-item ${currentPage === 'releases' ? 'active' : ''}">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                    </svg>
                    <span>Releases</span>
                </a>
                <a href="analytics.html" class="nav-item ${currentPage === 'analytics' ? 'active' : ''}">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/>
                    </svg>
                    <span>Analytics</span>
                </a>
            </div>

            <div class="nav-section nav-section-bottom">
                <a href="profile.html" class="nav-item ${currentPage === 'profile' ? 'active' : ''}">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/>
                    </svg>
                    <span>Edit Profile</span>
                </a>
                <a href="settings.html" class="nav-item ${currentPage === 'settings' ? 'active' : ''}">
                    <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                    </svg>
                    <span>Settings</span>
                </a>
            </div>

            <div class="sidebar-footer">
                <div class="session-info">
                    <div class="session-identity">
                        <span class="npub-badge" title="${session.npub}">${shortNpub}</span>
                        <span class="session-meta">
                            <span class="session-type">${sessionType}</span>
                            <span class="session-duration" id="session-duration">${SessionManager.getFormattedDuration()}</span>
                        </span>
                    </div>
                </div>
                <button class="logout-btn" onclick="AdminSidebar.logout()">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                    </svg>
                    Logout
                </button>
                <div class="sidebar-version">v0.1.0-alpha</div>
            </div>
        `;
    },

    /**
     * Inject CSS styles for sidebar components
     */
    _injectStyles() {
        // Check if styles already injected
        if (document.getElementById('admin-sidebar-styles')) return;

        const style = document.createElement('style');
        style.id = 'admin-sidebar-styles';
        style.textContent = `
            /* Sidebar Base */
            .sidebar {
                width: 240px;
                background: rgba(15, 15, 25, 0.8);
                backdrop-filter: blur(20px);
                border-right: 1px solid rgba(255, 255, 255, 0.05);
                display: flex;
                flex-direction: column;
                padding: 24px 16px;
                position: fixed;
                height: 100vh;
                overflow-y: auto;
                z-index: 100;
            }

            /* Logo */
            .sidebar .logo {
                display: flex;
                flex-direction: column;
                align-items: center;
                margin-bottom: 16px;
                padding: 0 8px;
            }

            .sidebar .logo-main {
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .sidebar .logo-main img {
                width: 160px;
                height: auto;
            }

            .sidebar .logo-subtitle {
                font-size: 13px;
                text-transform: uppercase;
                letter-spacing: 3px;
                color: #ffffff;
                margin-top: 6px;
                font-weight: 700;
            }

            /* Artist Profile */
            .sidebar .artist-profile {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px 12px;
                background: rgba(255, 255, 255, 0.03);
                border-radius: 12px;
                margin-bottom: 24px;
            }

            .sidebar .artist-avatar {
                width: 44px;
                height: 44px;
                border-radius: 50%;
                background: linear-gradient(135deg, #8b5cf6, #a855f7);
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 16px;
                flex-shrink: 0;
                overflow: hidden;
                color: #ffffff;
            }

            .sidebar .artist-avatar img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .sidebar .artist-info {
                flex: 1;
                min-width: 0;
            }

            .sidebar .artist-name {
                font-weight: 600;
                font-size: 14px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: #ffffff;
            }

            .sidebar .artist-status {
                font-size: 11px;
                color: #a855f7;
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .sidebar .artist-status::before {
                content: '';
                width: 6px;
                height: 6px;
                background: #a855f7;
                border-radius: 50%;
                animation: pulse-dot 2s infinite;
            }

            @keyframes pulse-dot {
                0%, 100% {
                    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.4);
                }
                50% {
                    box-shadow: 0 0 0 4px rgba(168, 85, 247, 0);
                }
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

            /* Sidebar Footer */
            .sidebar .sidebar-footer {
                margin-top: auto;
                padding-top: 24px;
                border-top: 1px solid rgba(255, 255, 255, 0.05);
            }

            .sidebar .session-info {
                padding: 12px;
                background: rgba(255, 255, 255, 0.02);
                border-radius: 10px;
                margin-bottom: 12px;
            }

            .sidebar .session-identity {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }

            .sidebar .npub-badge {
                padding: 4px 8px;
                background: rgba(168, 85, 247, 0.15);
                border: 1px solid rgba(168, 85, 247, 0.3);
                border-radius: 6px;
                color: #a855f7;
                font-size: 11px;
                font-family: monospace;
                flex-shrink: 0;
            }

            .sidebar .session-meta {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 2px;
            }

            .sidebar .session-type {
                font-size: 10px;
                color: rgba(255, 255, 255, 0.5);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                white-space: nowrap;
            }

            .sidebar .session-duration {
                font-size: 10px;
                color: rgba(255, 255, 255, 0.4);
                white-space: nowrap;
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

            .sidebar .sidebar-version {
                text-align: center;
                font-size: 10px;
                color: rgba(255, 255, 255, 0.25);
                letter-spacing: 0.5px;
                margin-top: 8px;
            }

            /* Main content adjustment */
            .main-content {
                margin-left: 240px;
            }

            /* Responsive */
            @media (max-width: 768px) {
                .sidebar {
                    display: none;
                }
                .main-content {
                    margin-left: 0;
                }
            }
        `;
        document.head.appendChild(style);
    },

    /**
     * Update artist display in sidebar
     */
    updateArtistDisplay(name, avatarUrl) {
        const nameEl = document.getElementById('sidebar-name');
        const avatarEl = document.getElementById('sidebar-avatar');

        if (nameEl) {
            nameEl.textContent = name || 'New Artist';
        }

        if (avatarEl) {
            if (avatarUrl) {
                avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${name || 'Avatar'}">`;
            } else {
                const initials = (name || 'NA').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
                avatarEl.textContent = initials;
            }
        }
    },

    /**
     * Start updating session duration display
     */
    _startDurationUpdater() {
        this._durationInterval = setInterval(() => {
            const durationEl = document.getElementById('session-duration');
            if (durationEl && SessionManager.hasSession()) {
                durationEl.textContent = SessionManager.getFormattedDuration();
            }
        }, 60000); // Update every minute
    },

    /**
     * Handle logout button click
     */
    logout() {
        SessionManager.logout();
        window.location.href = 'login.html';
    },

    /**
     * Destroy the sidebar
     */
    destroy() {
        if (this._durationInterval) {
            clearInterval(this._durationInterval);
            this._durationInterval = null;
        }
    }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AdminSidebar;
}
