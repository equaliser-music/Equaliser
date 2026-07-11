/**
 * Manager Authorizations Page Module (delegations)
 *
 * NIP-26 delegation inbox: pending requests from labels (Grant/Decline)
 * plus active authorizations with Revoke.
 */
(function() {
    'use strict';

    // @noble/curves' schnorr — needed for NIP-26 delegation signing.
    // nostr-tools' bundle doesn't expose schnorr, so we load it separately
    // as a dynamically imported ES module. SessionManager.signDelegation
    // waits on the 'noble-schnorr-ready' event if it hasn't landed yet.
    async function ensureNobleSchnorr() {
        if (window.nobleSchnorr) return;
        const { schnorr } = await import('https://esm.sh/@noble/curves@1.6.0/secp256k1');
        window.nobleSchnorr = schnorr;
        window.dispatchEvent(new Event('noble-schnorr-ready'));
    }

    async function loadAll() {
        await Promise.all([loadIncoming(), loadActive()]);
    }

    // ===== Incoming requests (artist's inbox) =====

    async function loadIncoming() {
        const container = document.getElementById('incoming-list');
        container.innerHTML = '<div style="text-align:center; padding:20px"><span class="loading-spinner"></span></div>';
        try {
            const resp = await SessionManager.authFetch('/api/delegations/incoming?status=pending');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            renderIncoming(data.requests || []);
        } catch (e) {
            container.innerHTML = '';
            showNotice('error', `Failed to load: ${e.message}`);
        }
    }

    function renderIncoming(requests) {
        const container = document.getElementById('incoming-list');
        if (!requests.length) {
            container.innerHTML = '<div class="empty-state"><h3>No pending requests</h3><p>Labels can request permission to publish on your behalf. You\'ll see those requests here.</p></div>';
            return;
        }
        container.innerHTML = requests.map(r => renderRequestCard(r)).join('');
    }

    function renderRequestCard(r) {
        const requestedAt = new Date(r.created_at).toLocaleString();
        const kinds = (r.requested_kinds || '').split(',').map(k => `<span class="kind-badge">Kind ${escapeHtml(k.trim())}</span>`).join('');
        return `
            <div class="request-card" data-request-id="${r.id}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px">
                    <div>
                        <div style="font-size:15px; font-weight:600">Delegation Request</div>
                        <div class="request-meta">From <span class="pubkey-mono">${escapeHtml(r.label_pubkey.slice(0,8))}…${escapeHtml(r.label_pubkey.slice(-4))}</span> · Requested ${requestedAt}</div>
                    </div>
                    <span class="badge badge-pending">pending</span>
                </div>

                <div class="request-field">
                    <div class="request-field-label">Permitted Event Kinds</div>
                    <div class="request-field-value kinds-list">${kinds}</div>
                </div>

                <div class="request-field">
                    <div class="request-field-label">Duration</div>
                    <div class="request-field-value">${r.requested_duration_days} days</div>
                </div>

                ${r.note ? `<div class="request-field"><div class="request-field-label">Note from label</div><div class="request-field-value">${escapeHtml(r.note)}</div></div>` : ''}

                <div class="request-actions">
                    <button class="btn btn-success" onclick="grantRequest(${r.id}, '${r.label_pubkey}', '${escapeHtml(r.requested_kinds)}', ${r.requested_duration_days})">Grant</button>
                    <button class="btn btn-danger" onclick="declineRequest(${r.id})">Decline</button>
                </div>
            </div>
        `;
    }

    async function grantRequest(requestId, labelPubkey, requestedKinds, durationDays) {
        const session = SessionManager.getSession();
        if (session.type !== 'nsec') {
            showNotice('error', 'Granting delegations requires an nsec session — please log in with nsec rather than a NIP-07 extension.');
            return;
        }

        try {
            const kinds = requestedKinds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            const since = Math.floor(Date.now() / 1000) - 60;
            const until = since + Math.max(durationDays, 1) * 86400 + 60;

            const { conditions, signature } = await SessionManager.signDelegation(labelPubkey, {
                kinds, since, until,
            });

            const resp = await SessionManager.authFetch(`/api/delegations/${requestId}/grant`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conditions, signature }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            showNotice('success', 'Delegation granted.');
            await loadAll();
        } catch (e) {
            showNotice('error', `Grant failed: ${e.message}`);
        }
    }

    async function declineRequest(requestId) {
        if (!confirm('Decline this delegation request?')) return;
        try {
            const resp = await SessionManager.authFetch(`/api/delegations/${requestId}/decline`, { method: 'POST' });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            showNotice('success', 'Request declined.');
            await loadAll();
        } catch (e) {
            showNotice('error', `Decline failed: ${e.message}`);
        }
    }

    // ===== Active delegations (artist's grants) =====

    async function loadActive() {
        const container = document.getElementById('active-list');
        container.innerHTML = '<div style="text-align:center; padding:20px"><span class="loading-spinner"></span></div>';
        try {
            // Re-use the artist's delegation_requests endpoint filtered by status=granted —
            // the relay's active table is keyed by (artist, label) so we'd need an extra
            // endpoint to read it. For v1, reading granted requests is sufficient and
            // shows revocation state via /active/{label} per row if needed.
            const resp = await SessionManager.authFetch('/api/delegations/incoming?status=granted');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            renderActive(data.requests || []);
        } catch (e) {
            container.innerHTML = '';
            showNotice('error', `Failed to load active delegations: ${e.message}`);
        }
    }

    function renderActive(items) {
        const container = document.getElementById('active-list');
        if (!items.length) {
            container.innerHTML = '<div class="empty-state"><h3>No active delegations</h3><p>Once you grant a request above, it will appear here. You can revoke at any time.</p></div>';
            return;
        }
        container.innerHTML = items.map(r => `
            <div class="delegation-row">
                <div>
                    <div><strong>Label</strong> <span class="pubkey-mono">${escapeHtml(r.label_pubkey.slice(0,8))}…${escapeHtml(r.label_pubkey.slice(-4))}</span></div>
                    <div class="request-meta">Granted ${new Date(r.responded_at || r.created_at).toLocaleString()} · Kinds: ${escapeHtml(r.requested_kinds)}</div>
                </div>
                <span class="badge badge-active">active</span>
                <button class="btn btn-small btn-danger" onclick="revoke('${r.label_pubkey}')">Revoke</button>
            </div>
        `).join('');
    }

    async function revoke(labelPubkey) {
        if (!confirm('Revoke this delegation? The label will no longer be able to publish on your behalf.')) return;
        try {
            const myPubkey = SessionManager.getSession().publicKey;
            const resp = await SessionManager.authFetch(`/api/delegations/${myPubkey}/revoke?label_pubkey=${labelPubkey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label_pubkey: labelPubkey }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            showNotice('success', 'Delegation revoked.');
            await loadAll();
        } catch (e) {
            showNotice('error', `Revoke failed: ${e.message}`);
        }
    }

    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type === 'success') setTimeout(() => { area.innerHTML = ''; }, 4000);
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    const DelegationsPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadAll = loadAll;
            window.grantRequest = grantRequest;
            window.declineRequest = declineRequest;
            window.revoke = revoke;

            // Kick off the schnorr module load in parallel (matches the original
            // <script type="module"> behaviour); signDelegation waits on the
            // ready event if a grant happens before it lands.
            ensureNobleSchnorr().catch(e => console.error('Failed to load @noble/curves schnorr:', e));

            await loadAll();
        },

        cleanup() {
            delete window.loadAll;
            delete window.grantRequest;
            delete window.declineRequest;
            delete window.revoke;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['delegations'] = DelegationsPage;
})();
