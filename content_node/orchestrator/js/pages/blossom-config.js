/**
 * Blossom Config Page Module (operator)
 *
 * Blossom server status + future mirroring placeholder card.
 */
(function() {
    'use strict';

    async function loadStatus() {
        const content = document.getElementById('content');
        content.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';
        try {
            const resp = await SessionManager.authFetch('/api/operator/blossom/status');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            render(await resp.json());
        } catch (e) {
            content.innerHTML = '';
            showNotice('error', `Failed to load Blossom status: ${e.message}`);
        }
    }

    function render(data) {
        document.getElementById('content').innerHTML = `
            <div data-testid="blossom-status">
                <div class="info-row">
                    <span class="info-label">Server URL</span>
                    <span class="info-value">${escapeHtml(data.url || '—')}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Public URL</span>
                    <span class="info-value">${data.public_url ? escapeHtml(data.public_url) : '<span class="eq-muted-inherit">not configured</span>'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Status</span>
                    <span class="badge ${data.status === 'ok' ? 'badge-active' : 'badge-suspended'}" data-testid="status-badge">${data.status}${data.http_status ? ` (${data.http_status})` : ''}</span>
                </div>
                ${data.error ? `<div class="notice notice-error">Error: ${escapeHtml(data.error)}</div>` : ''}
            </div>

            <div class="future-card">
                <h3>Mirroring & Cluster Config — coming soon</h3>
                <p>Cross-node Blossom mirroring lets content nodes replicate audio blobs to peers for redundancy. The schema (<code>blossom_servers</code>, <code>blossom_mirrors</code>) already exists in the relay's PostgreSQL.</p>
                <p>Planned controls:</p>
                <ul>
                    <li>Add/remove mirror server URLs</li>
                    <li>Per-mirror sync policy (auto-mirror new blobs, on-demand only, etc.)</li>
                    <li>Storage quota and retention</li>
                    <li>Health monitoring per mirror</li>
                </ul>
                <p style="margin-top:12px">Tracked in <code>NODE-MANAGEMENT-SPEC.md</code> Section 7 (IPFS Cluster &amp; Blossom Mirroring).</p>
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

    const BlossomConfigPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadStatus = loadStatus;

            if (SessionManager.getRole() !== 'operator') {
                showNotice('error', 'You need an operator role to view this page.');
                document.getElementById('content').innerHTML = '';
                return;
            }
            await loadStatus();
        },

        cleanup() {
            delete window.loadStatus;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['blossom-config'] = BlossomConfigPage;
})();
