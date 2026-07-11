/**
 * Equaliser Admin SPA Router
 *
 * Admin counterpart of the client router (client/js/router.js). Intercepts
 * navigation links and loads page content dynamically into the admin shell's
 * content area (app.html #page-content). The sidebar persists across page
 * transitions, killing the background flash on navigation.
 *
 * Pages register themselves via window.EqualiserAdminPages[pageName] = { init(params), cleanup() }
 * Page modules live at /admin/js/pages/<name>.js; raw page HTML is fetched
 * from /admin/raw/<name>.html (nginx alias that bypasses the SPA rewrite).
 */

const AdminRouter = {
    _contentEl: null,
    _pageStyleEl: null,
    _currentPageName: null,
    _currentPageModule: null,
    _loadedScripts: new Set(),
    _isNavigating: false,

    // Pages that should NOT be loaded in the app shell (pre-session / gated flows)
    _standalonePages: new Set(['login', 'setup', 'redeem', 'onboarding', 'profile-setup']),

    // Pages served through the shell. Module path derives from the page name.
    _shellPages: new Set([
        'dashboard', 'releases', 'edit-release', 'profile', 'upload', 'settings',
        'artist-management', 'access-requests', 'invite-codes', 'delegations',
        'node-overview', 'sync-manager', 'ipfs-storage', 'blossom-config',
        'user-cache', 'node-settings'
    ]),

    init() {
        this._contentEl = document.getElementById('page-content');
        if (!this._contentEl) {
            console.error('AdminRouter: #page-content element not found');
            return;
        }

        // Style element for page-specific styles
        this._pageStyleEl = document.createElement('style');
        this._pageStyleEl.id = 'eq-page-styles';
        document.head.appendChild(this._pageStyleEl);

        // Intercept link clicks (capture phase, same rationale as client router)
        document.addEventListener('click', (e) => this._handleClick(e), true);

        // Handle browser back/forward
        window.addEventListener('popstate', () => {
            const path = window.location.pathname + window.location.search;
            this._loadPage(path, false);
        });

        if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};

        // Load the initial page based on current URL. Unknown admin URLs fall
        // back to the dashboard (mirrors the old nginx try_files fallback) —
        // a full-navigation redirect here would loop, since nginx serves the
        // shell for those URLs.
        let path = window.location.pathname + window.location.search;
        const pageName = this._getPageName(path);
        if (!this._shellPages.has(pageName)) {
            path = '/admin/dashboard.html';
            history.replaceState({ path }, '', path);
        }
        this._loadPage(path, false);
    },

    /**
     * Navigate to a new page programmatically
     */
    navigate(path) {
        if (this._isNavigating) return;
        this._loadPage(this._resolve(path), true);
    },

    getCurrentPage() {
        return this._currentPageName;
    },

    // ===== Internal Methods =====

    /** Resolve a possibly-relative href (e.g. "releases.html") against /admin/ */
    _resolve(href) {
        const url = new URL(href, window.location.origin + '/admin/');
        return url.pathname + url.search;
    },

    _handleClick(e) {
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

        const path = this._resolve(href);

        // Skip anything that leaves the admin surface (e.g. "Listener View" → /)
        if (!path.startsWith('/admin')) return;

        const pageName = this._getPageName(path);

        // Standalone pages and unknown pages do a full navigation
        if (!this._shellPages.has(pageName)) return;

        e.preventDefault();
        this._loadPage(path, true);
    },

    _getPageName(path) {
        const pathname = path.split('?')[0].split('#')[0];
        const filename = pathname.split('/').pop() || '';
        return filename.replace('.html', '') || 'dashboard';
    },

    async _loadPage(path, pushState) {
        if (this._isNavigating) return;
        this._isNavigating = true;

        try {
            const pageName = this._getPageName(path);

            if (!this._shellPages.has(pageName)) {
                window.location.href = path;
                return;
            }

            // Cleanup current page
            this._cleanupCurrentPage();

            // Fetch the raw page HTML (via /admin/raw/ to bypass the SPA rewrite)
            const htmlPath = '/admin/raw/' + pageName + '.html';
            const response = await fetch(htmlPath);
            if (!response.ok) {
                console.error(`AdminRouter: Failed to fetch ${htmlPath}: ${response.status}`);
                this._isNavigating = false;
                return;
            }

            const html = await response.text();
            const { content, styles, title } = this._extractPage(html);

            this._pageStyleEl.textContent = styles;
            this._contentEl.innerHTML = content;

            if (title) document.title = title;

            if (pushState) {
                history.pushState({ path }, title || '', path);
            }

            // Update sidebar active nav item
            if (typeof AdminSidebar !== 'undefined' && AdminSidebar.updateActiveState) {
                AdminSidebar.updateActiveState(path);
            }

            // Re-attach the "Acting as" banner to the freshly injected .main-content
            if (typeof AdminSidebar !== 'undefined' && AdminSidebar.renderActingAsBanner) {
                AdminSidebar.renderActingAsBanner();
            }

            // Scroll the injected main content back to the top
            const scrollEl = this._contentEl.querySelector('.main-content');
            if (scrollEl) scrollEl.scrollTop = 0;

            // Load and initialize the page module
            this._currentPageName = pageName;
            await this._loadPageModule(pageName);

            const url = new URL(path, window.location.origin);
            const params = Object.fromEntries(url.searchParams.entries());

            const pageModule = window.EqualiserAdminPages[pageName];
            if (pageModule && pageModule.init) {
                this._currentPageModule = pageModule;
                // Fire-and-forget (matches the client router): awaiting init here
                // would hold _isNavigating until the page's data fetches settle,
                // silently swallowing any navigation clicked in that window.
                Promise.resolve(pageModule.init(params)).catch(err => {
                    console.error(`AdminRouter: ${pageName} init error:`, err);
                });
            }

        } catch (error) {
            console.error('AdminRouter: Navigation error:', error);
        } finally {
            this._isNavigating = false;
        }
    },

    _extractPage(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const titleEl = doc.querySelector('title');
        const title = titleEl ? titleEl.textContent : '';

        // Collect page-specific styles, skipping shared stylesheets the shell
        // already provides (theme, admin-base) — only inline <style> blocks.
        let styles = '';
        doc.querySelectorAll('style').forEach(el => {
            styles += el.textContent + '\n';
        });

        // Extract page content from .container, minus shell-provided elements
        let content = '';
        const container = doc.querySelector('.container');
        if (container) {
            const sidebar = container.querySelector(':scope > .sidebar');
            if (sidebar) sidebar.remove();
            container.querySelectorAll('script').forEach(el => el.remove());
            content = container.innerHTML;
        } else {
            const body = doc.body.cloneNode(true);
            body.querySelectorAll('script, style').forEach(el => el.remove());
            const sidebar = body.querySelector('.sidebar');
            if (sidebar) sidebar.remove();
            content = body.innerHTML;
        }

        return { content, styles, title };
    },

    async _loadPageModule(pageName) {
        const modulePath = '/admin/js/pages/' + pageName + '.js';

        if (this._loadedScripts.has(modulePath)) return;

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = modulePath + '?v=' + Date.now();
            script.onload = () => {
                this._loadedScripts.add(modulePath);
                resolve();
            };
            script.onerror = (e) => {
                console.error(`AdminRouter: Failed to load ${modulePath}`, e);
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
                console.error('AdminRouter: Page cleanup error:', e);
            }
        }
        this._currentPageModule = null;
        this._currentPageName = null;

        if (this._pageStyleEl) this._pageStyleEl.textContent = '';
        if (this._contentEl) this._contentEl.innerHTML = '';
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AdminRouter;
}
