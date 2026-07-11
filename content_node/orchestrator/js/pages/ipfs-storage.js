/**
 * IPFS Storage Page Module (operator)
 *
 * Repo stats, pin count, swarm peers, sample pinned CIDs.
 */
(function() {
    'use strict';

    async function loadStats() {
        const content = document.getElementById('content');
        content.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';
        try {
            const resp = await SessionManager.authFetch('/api/operator/ipfs/stats');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            render(await resp.json());
        } catch (e) {
            content.innerHTML = '';
            showNotice('error', `Failed to load IPFS stats: ${e.message}`);
        }
    }

    function render(data) {
        const repo = data.repo || {};
        const tiles = [
            { label: 'Repo Size', value: humanBytes(repo.RepoSize) },
            { label: 'Storage Max', value: humanBytes(repo.StorageMax) },
            { label: 'Objects', value: repo.NumObjects ?? '—' },
            { label: 'Pinned (recursive)', value: data.pin_count ?? '—' },
            { label: 'Swarm Peers', value: data.swarm_peer_count ?? '—' },
        ];

        document.getElementById('content').innerHTML = `
            <div class="id-row" data-testid="ipfs-peer-id">
                <strong class="eq-strong-label">Peer ID:</strong> ${escapeHtml(data.peer_id || '—')}
                ${data.agent_version ? `<br><strong class="eq-strong-label">Agent:</strong> ${escapeHtml(data.agent_version)}` : ''}
                <br><strong class="eq-strong-label">API URL:</strong> ${escapeHtml(data.api_url || '')}
            </div>

            <div class="stat-grid" data-testid="ipfs-stats">
                ${tiles.map(t => `
                    <div class="stat-tile">
                        <div class="stat-value">${t.value}</div>
                        <div class="stat-label">${t.label}</div>
                    </div>
                `).join('')}
            </div>

            <div class="section">
                <h2>Recent Pinned CIDs <span class="eq-muted-14">(sample of ${(data.pins_sample || []).length})</span></h2>
                ${(data.pins_sample || []).length === 0 ? `
                    <div class="empty-state"><h3>No pinned content</h3><p>Pinned CIDs will appear here once tracks are uploaded.</p></div>
                ` : `
                    <table class="data-table">
                        <thead><tr><th>CID</th><th style="text-align:right">Actions</th></tr></thead>
                        <tbody>
                            ${(data.pins_sample || []).map(cid => `
                                <tr>
                                    <td><span class="pin-cell">${escapeHtml(cid)}</span></td>
                                    <td><div class="row-actions">
                                        <a class="btn btn-small btn-secondary" target="_blank" rel="noopener" href="/ipfs/${encodeURIComponent(cid)}">View</a>
                                    </div></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                `}
            </div>
        `;
    }

    function humanBytes(n) {
        if (typeof n !== 'number') return '—';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
    }
    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type !== 'error') setTimeout(() => { area.innerHTML = ''; }, 4000);
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    const IpfsStoragePage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadStats = loadStats;

            if (SessionManager.getRole() !== 'operator') {
                showNotice('error', 'You need an operator role to view this page.');
                document.getElementById('content').innerHTML = '';
                return;
            }
            await loadStats();
        },

        cleanup() {
            delete window.loadStats;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['ipfs-storage'] = IpfsStoragePage;
})();
