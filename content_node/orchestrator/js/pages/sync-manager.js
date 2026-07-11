/**
 * Sync Manager Page Module (operator)
 *
 * Peer relay table, standard NOSTR relay list, local relay info.
 */
(function() {
    'use strict';

    async function loadSync() {
        const content = document.getElementById('content');
        content.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';
        try {
            const resp = await SessionManager.authFetch('/api/operator/sync/peers');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            render(await resp.json());
        } catch (e) {
            content.innerHTML = '';
            showNotice('error', `Failed to load sync state: ${e.message}`);
        }
    }

    function render(data) {
        const peers = data.peer_relays || [];
        const std = data.standard_relays || [];
        const localUrl = data.local_relay_url || '';

        document.getElementById('content').innerHTML = `
            <div class="section">
                <h2>Equaliser Peer Relays <span class="eq-muted-14">(${peers.length})</span></h2>
                <p class="page-description" style="margin-bottom:12px">Other Equaliser content nodes this relay syncs music metadata with. Configure via <code>PEER_RELAYS</code> env var.</p>
                ${peers.length === 0 ? `
                    <div class="empty-state"><h3>No peer relays configured</h3><p>This node operates standalone. To peer with other Equaliser nodes, set the <code>PEER_RELAYS</code> environment variable.</p></div>
                ` : `
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>URL</th>
                                <th>Status</th>
                                <th>Events</th>
                                <th>Errors</th>
                                <th>Last Connected</th>
                                <th>Last Event</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${peers.map(p => renderPeerRow(p)).join('')}
                        </tbody>
                    </table>
                `}
            </div>

            <div class="section">
                <h2>Standard NOSTR Relays <span class="eq-muted-14">(${std.length})</span></h2>
                <p class="page-description" style="margin-bottom:12px">Open NOSTR relays the syncer pulls user-cache data from (Kind 0/1/3/5/6/7 for registered listeners). Configure via <code>STANDARD_RELAYS</code> env var.</p>
                ${std.length === 0 ? `
                    <div class="empty-state"><h3>No standard relays configured</h3><p>Set <code>STANDARD_RELAYS</code> to enable user-cache backfill from the wider NOSTR network.</p></div>
                ` : `
                    <div class="relay-list-simple">
                        ${std.map(url => `
                            <div class="relay-row">
                                <span class="relay-url-mono">${escapeHtml(url)}</span>
                                <span class="badge badge-active">configured</span>
                            </div>
                        `).join('')}
                    </div>
                `}
            </div>

            <div class="section">
                <h2>Local Relay</h2>
                <div class="relay-list-simple">
                    <div class="relay-row">
                        <span class="relay-url-mono">${escapeHtml(localUrl)}</span>
                        <span class="badge badge-active">in-process</span>
                    </div>
                </div>
            </div>
        `;
    }

    function renderPeerRow(p) {
        const lastConn = p.last_connected_at ? new Date(p.last_connected_at).toLocaleString() : '—';
        const lastEvt = p.last_event_at ? new Date(p.last_event_at * 1000).toLocaleString() : '—';
        return `
            <tr>
                <td><span class="relay-url-mono">${escapeHtml(p.url)}</span></td>
                <td><span class="badge badge-${p.status}">${p.status}</span></td>
                <td>${p.event_count ?? 0}</td>
                <td>${p.error_count ?? 0}${p.last_error ? ` <span title="${escapeHtml(p.last_error)}" class="eq-error-help">(?)</span>` : ''}</td>
                <td class="eq-dim-13">${lastConn}</td>
                <td class="eq-dim-13">${lastEvt}</td>
            </tr>
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

    const SyncManagerPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadSync = loadSync;

            if (SessionManager.getRole() !== 'operator') {
                showNotice('error', 'You need an operator role to view this page.');
                document.getElementById('content').innerHTML = '';
                return;
            }
            await loadSync();
        },

        cleanup() {
            delete window.loadSync;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['sync-manager'] = SyncManagerPage;
})();
