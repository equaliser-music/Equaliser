/**
 * Node Overview Page Module (operator)
 *
 * Stat tiles + service health for this content node.
 */
(function() {
    'use strict';

    async function loadOverview() {
        const content = document.getElementById('content');
        if (!content) return;
        content.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';

        try {
            const resp = await SessionManager.authFetch('/api/operator/overview');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            render(data);
        } catch (e) {
            content.innerHTML = '';
            showNotice('error', `Failed to load overview: ${e.message}`);
        }
    }

    function render(data) {
        const stats = data.stats || {};
        const services = data.services || {};
        const content = document.getElementById('content');

        const tiles = [
            { label: 'Artists', value: stats.artist_count ?? 0 },
            { label: 'Labels', value: stats.label_count ?? 0 },
            { label: 'Operators', value: stats.operator_count ?? 0 },
            { label: 'Listeners', value: stats.user_count ?? 0 },
            { label: 'Events', value: stats.event_count ?? 0 },
            { label: 'Releases', value: stats.release_count ?? 0 },
            { label: 'Pending Requests', value: stats.pending_requests ?? 0 },
        ];

        content.innerHTML = `
            <div class="node-meta">
                <div>
                    <div class="meta-label">Node Name</div>
                    <div class="meta-value">${escapeHtml(data.node_name || '—')}</div>
                </div>
                <div>
                    <div class="meta-label">Public Base URL</div>
                    <div class="meta-value">${data.public_base_url ? escapeHtml(data.public_base_url) : '<span class="eq-muted">not configured</span>'}</div>
                </div>
            </div>

            <div class="stat-grid" data-testid="stat-grid">
                ${tiles.map(t => `
                    <div class="stat-tile">
                        <div class="stat-value">${t.value}</div>
                        <div class="stat-label">${t.label}</div>
                    </div>
                `).join('')}
            </div>

            <div class="services-section">
                <h2>Service Health</h2>
                ${Object.entries(services).map(([name, info]) => `
                    <div class="service-row" data-service="${name}">
                        <div>
                            <div class="service-name"><span class="health-dot ${info.status}"></span>${name}</div>
                            <div class="service-url">${info.url ? escapeHtml(info.url) : ''}</div>
                        </div>
                        <div>
                            <span class="badge ${badgeClass(info.status)}">${info.status}${info.http_status ? ` (${info.http_status})` : ''}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function badgeClass(status) {
        return status === 'ok' ? 'badge-active' : 'badge-suspended';
    }

    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type !== 'error') setTimeout(() => { area.innerHTML = ''; }, 4000);
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    const NodeOverviewPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadOverview = loadOverview;

            if (SessionManager.getRole() !== 'operator') {
                showNotice('error', 'You need an operator role to view this page.');
                document.getElementById('content').innerHTML = '';
                return;
            }
            await loadOverview();
        },

        cleanup() {
            delete window.loadOverview;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['node-overview'] = NodeOverviewPage;
})();
