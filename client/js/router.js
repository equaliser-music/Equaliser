/**
 * Equaliser SPA Router
 *
 * Intercepts navigation links and loads page content dynamically into
 * the app shell's content area. The player and sidebar persist across
 * page transitions.
 *
 * Usage:
 *   1. Include after session.js, sidebar.js, player.js
 *   2. Call Router.init() after other modules are initialized
 *
 * Pages register themselves via window.EqualiserPages[pageName] = { init(), cleanup() }
 */

const Router = {
    _contentEl: null,
    _pageStyleEl: null,
    _currentPageName: null,
    _currentPageModule: null,
    _loadedScripts: new Set(),
    _isNavigating: false,

    // Pages that should NOT be loaded in the app shell
    _standalonePages: new Set(['login', 'onboarding', 'index']),

    // Map page names to their JS module paths
    _pageModules: {
        'home': '/js/pages/home.js',
        'social': '/js/pages/social.js',
        'profile': '/js/pages/profile.js',
        'artist': '/js/pages/artist.js',
        'user': '/js/pages/user.js',
        'thread': '/js/pages/thread.js',
        'messages': '/js/pages/messages.js',
        'settings': '/js/pages/settings.js'
    },

    /**
     * Initialize the router
     */
    init() {
        this._contentEl = document.getElementById('page-content');
        if (!this._contentEl) {
            console.error('Router: #page-content element not found');
            return;
        }

        // Create a style element for page-specific styles
        this._pageStyleEl = document.createElement('style');
        this._pageStyleEl.id = 'eq-page-styles';
        document.head.appendChild(this._pageStyleEl);

        // Intercept link clicks
        document.addEventListener('click', (e) => this._handleClick(e));

        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            const path = window.location.pathname + window.location.search;
            this._loadPage(path, false);
        });

        // Ensure the page-level registry exists
        if (!window.EqualiserPages) window.EqualiserPages = {};

        // Load the initial page based on current URL
        const path = window.location.pathname + window.location.search;
        this._loadPage(path, false);
    },

    /**
     * Navigate to a new page programmatically
     */
    navigate(path) {
        if (this._isNavigating) return;
        this._loadPage(path, true);
    },

    /**
     * Get the current page name
     */
    getCurrentPage() {
        return this._currentPageName;
    },

    // ===== Internal Methods =====

    _handleClick(e) {
        // Find the closest <a> tag
        const link = e.target.closest('a[href]');
        if (!link) return;

        const href = link.getAttribute('href');
        if (!href) return;

        // Skip external links, anchors, javascript:, mailto:, etc.
        if (href.startsWith('http') || href.startsWith('#') ||
            href.startsWith('javascript:') || href.startsWith('mailto:') ||
            href.startsWith('nostr:')) return;

        // Skip links with target attributes
        if (link.target) return;

        // Skip admin pages
        if (href.startsWith('/admin')) return;

        // Determine the page name from the href
        const pageName = this._getPageName(href);

        // Skip standalone pages - let them do a full navigation
        if (this._standalonePages.has(pageName)) return;

        // Skip if we don't have a module for this page
        if (!this._pageModules[pageName]) return;

        // Intercept the click
        e.preventDefault();
        this._loadPage(href, true);
    },

    _getPageName(path) {
        // Extract page name from path like "/social.html" or "/social.html?tab=community"
        const pathname = path.split('?')[0].split('#')[0];
        const filename = pathname.split('/').pop() || '';
        const name = filename.replace('.html', '') || 'home';

        // Handle redirect pages
        if (name === 'feed') return 'social';
        if (name === 'community') return 'social';

        return name;
    },

    async _loadPage(path, pushState) {
        if (this._isNavigating) return;
        this._isNavigating = true;

        try {
            const pageName = this._getPageName(path);

            // Check for standalone pages
            if (this._standalonePages.has(pageName)) {
                window.location.href = path;
                return;
            }

            // Check if we have a module for this page
            if (!this._pageModules[pageName]) {
                window.location.href = path;
                return;
            }

            // Cleanup current page
            this._cleanupCurrentPage();

            // Fetch the raw page HTML (via /raw/ prefix to bypass SPA rewrite)
            const htmlPath = '/raw/' + pageName + '.html';
            const response = await fetch(htmlPath);
            if (!response.ok) {
                console.error(`Router: Failed to fetch ${htmlPath}: ${response.status}`);
                this._isNavigating = false;
                return;
            }

            const html = await response.text();

            // Extract content and styles
            const { content, styles, title } = this._extractPage(html);

            // Inject styles
            this._pageStyleEl.textContent = styles;

            // Inject content
            this._contentEl.innerHTML = content;

            // Update page title
            if (title) document.title = title;

            // Update URL
            if (pushState) {
                history.pushState({ path }, title || '', path);
            }

            // Update sidebar active state
            if (typeof ClientSidebar !== 'undefined' && ClientSidebar.updateActiveState) {
                ClientSidebar.updateActiveState(path);
            }

            // Scroll to top (scroll the inner .main-content, not the wrapper)
            const scrollEl = this._contentEl.querySelector('.main-content');
            if (scrollEl) scrollEl.scrollTop = 0;

            // Load and initialize the page module
            this._currentPageName = pageName;
            await this._loadPageModule(pageName);

            // Extract query params and pass to init
            const url = new URL(path, window.location.origin);
            const params = Object.fromEntries(url.searchParams.entries());

            const pageModule = window.EqualiserPages[pageName];
            if (pageModule && pageModule.init) {
                this._currentPageModule = pageModule;
                pageModule.init(params);
            }

        } catch (error) {
            console.error('Router: Navigation error:', error);
        } finally {
            this._isNavigating = false;
        }
    },

    _extractPage(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Extract title
        const titleEl = doc.querySelector('title');
        const title = titleEl ? titleEl.textContent : '';

        // Extract styles (first <style> in <head> or <body>)
        let styles = '';
        const styleEls = doc.querySelectorAll('style');
        styleEls.forEach(el => {
            styles += el.textContent + '\n';
        });

        // Extract page content from .container, preserving layout structure
        // This keeps .main-content and any siblings (e.g. .nostr-sidebar) as flex children
        let content = '';
        const container = doc.querySelector('.container');
        if (container) {
            // Remove elements the app shell provides
            const sidebar = container.querySelector(':scope > .sidebar');
            if (sidebar) sidebar.remove();
            const playerBar = container.querySelector(':scope > .player-bar');
            if (playerBar) playerBar.remove();
            // Remove any scripts
            container.querySelectorAll('script').forEach(el => el.remove());
            content = container.innerHTML;
        } else {
            // Fall back to the full body minus scripts, styles, sidebar, player
            const body = doc.body.cloneNode(true);
            body.querySelectorAll('script, style').forEach(el => el.remove());
            const sidebar = body.querySelector('.sidebar');
            if (sidebar) sidebar.remove();
            const playerBar = body.querySelector('.player-bar');
            if (playerBar) playerBar.remove();
            content = body.innerHTML;
        }

        return { content, styles, title };
    },

    async _loadPageModule(pageName) {
        const modulePath = this._pageModules[pageName];
        if (!modulePath) return;

        // Don't reload if already loaded
        if (this._loadedScripts.has(modulePath)) return;

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = modulePath + '?v=' + Date.now();
            script.onload = () => {
                this._loadedScripts.add(modulePath);
                resolve();
            };
            script.onerror = (e) => {
                console.error(`Router: Failed to load ${modulePath}`, e);
                reject(e);
            };
            document.body.appendChild(script);
        });
    },

    _cleanupCurrentPage() {
        if (this._currentPageModule && this._currentPageModule.cleanup) {
            try {
                this._currentPageModule.cleanup();
            } catch (e) {
                console.error('Router: Page cleanup error:', e);
            }
        }
        this._currentPageModule = null;
        this._currentPageName = null;

        // Clear page-specific styles
        if (this._pageStyleEl) this._pageStyleEl.textContent = '';

        // Clear content
        if (this._contentEl) this._contentEl.innerHTML = '';
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Router;
}
