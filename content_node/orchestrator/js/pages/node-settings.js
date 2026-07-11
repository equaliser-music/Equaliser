/**
 * Node Settings Page Module (operator)
 *
 * Read-only env config grouped into Node / Services / Relays / CORS sections.
 */
(function() {
    'use strict';

    async function loadSettings() {
        const content = document.getElementById('content');
        content.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';
        try {
            const resp = await SessionManager.authFetch('/api/operator/settings');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            render(await resp.json());
        } catch (e) {
            content.innerHTML = '';
            showNotice('error', `Failed to load settings: ${e.message}`);
        }
    }

    function render(data) {
        document.getElementById('content').innerHTML = `
            <div class="read-only-banner">
                Settings are sourced from environment variables on the orchestrator. Edit your <code>docker-compose.yml</code> or <code>.env</code> file and restart containers to change these.
            </div>

            ${section('Node', data.node, {
                name: 'RELAY_NAME',
                public_base_url: 'PUBLIC_BASE_URL',
            })}

            ${section('Service URLs', data.services, {
                ipfs_api_url: 'IPFS_API_URL',
                blossom_url: 'BLOSSOM_URL',
                relay_rest_url: 'RELAY_API_URL',
                relay_ws_url: 'NOSTR_RELAY_URL',
            })}

            ${listSection('Standard NOSTR Relays', data.relays?.standard_relays, 'STANDARD_RELAYS')}
            ${listSection('Allowed CORS Origins', data.cors?.allowed_origins, 'ALLOWED_ORIGINS')}
        `;
    }

    function section(title, obj, envMap) {
        if (!obj) return '';
        const rows = Object.entries(envMap).map(([key, env]) => {
            const value = obj[key];
            return `
                <div class="setting-row">
                    <div class="setting-key">${escapeHtml(env)}</div>
                    <div class="setting-value ${value ? '' : 'empty'}">${value ? escapeHtml(String(value)) : '(not set)'}</div>
                </div>
            `;
        }).join('');
        return `<div class="settings-section"><h2>${escapeHtml(title)}</h2>${rows}</div>`;
    }

    function listSection(title, list, envName) {
        const items = (list || []);
        return `
            <div class="settings-section">
                <h2>${escapeHtml(title)}</h2>
                <div class="setting-row">
                    <div class="setting-key">${escapeHtml(envName)}</div>
                    <div class="setting-list">
                        ${items.length === 0
                            ? '<span class="setting-value empty">(none configured)</span>'
                            : items.map(v => `<span class="setting-value">${escapeHtml(v)}</span>`).join('')
                        }
                    </div>
                </div>
            </div>
        `;
    }

    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type !== 'error') setTimeout(() => { area.innerHTML = ''; }, 4000);
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    const NodeSettingsPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadSettings = loadSettings;

            if (SessionManager.getRole() !== 'operator') {
                showNotice('error', 'You need an operator role to view this page.');
                document.getElementById('content').innerHTML = '';
                return;
            }
            await loadSettings();
        },

        cleanup() {
            delete window.loadSettings;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['node-settings'] = NodeSettingsPage;
})();
