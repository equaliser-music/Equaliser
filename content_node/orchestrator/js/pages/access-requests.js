/**
 * Access Requests Page Module (operator)
 *
 * Pending/Approved/Declined tabs, approve modal (generates invite code,
 * shown in a second modal), decline modal with admin notes.
 */
(function() {
    'use strict';

    let cache = { pending: [], approved: [], declined: [] };
    let activeTab = 'pending';
    let actionRequestId = null;

    async function loadAll() {
        await Promise.all([
            loadStatus('pending'),
            loadStatus('approved'),
            loadStatus('declined'),
        ]);
        renderActiveTab();
    }

    async function loadStatus(status) {
        try {
            const resp = await SessionManager.authFetch(`/api/label/access-requests?status=${status}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            cache[status] = data.requests || [];
            document.getElementById(`count-${status}`).textContent = cache[status].length;
        } catch (e) {
            showNotice('error', `Failed to load ${status} requests: ${e.message}`);
            cache[status] = [];
        }
    }

    function switchTab(status) {
        activeTab = status;
        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.status === status);
        });
        renderActiveTab();
    }

    function renderActiveTab() {
        const list = cache[activeTab] || [];
        const container = document.getElementById('requests-container');

        if (!list.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No ${activeTab} requests</h3>
                    <p>${emptyMessage(activeTab)}</p>
                </div>
            `;
            return;
        }

        container.innerHTML = list.map(r => renderCard(r, activeTab)).join('');
    }

    function emptyMessage(status) {
        return {
            pending: 'New access requests will appear here when artists apply via /join.',
            approved: 'Approved requests will appear here once you generate invite codes.',
            declined: 'Declined requests are kept for record-keeping.',
        }[status] || '';
    }

    function renderCard(r, status) {
        const requestedAt = new Date(r.requested_at).toLocaleString();
        const reviewedAt = r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : null;
        const linksHtml = r.links ? renderLinks(r.links) : '';
        const requestedRole = r.requested_role || 'artist';
        const targetRole = r.target_role || requestedRole;

        // For approved cards, show what was granted (target_role) — possibly different from requested
        const grantedHtml = status !== 'pending' && targetRole
            ? `<span class="badge badge-${targetRole}" style="margin-left:6px">granted: ${targetRole}</span>`
            : '';

        const issuedByHtml = r.issued_by
            ? `<div class="request-field"><div class="request-field-label">Issued by</div><div class="request-field-value pubkey-cell">${escapeHtml(r.issued_by.slice(0,8))}…${escapeHtml(r.issued_by.slice(-4))}</div></div>`
            : '';

        return `
            <div class="request-card" data-request-id="${r.id}">
                <div class="request-header">
                    <div>
                        <div class="request-name">${escapeHtml(r.artist_name)}</div>
                        <div class="request-meta">
                            Request #${r.id} · Requested ${requestedAt}
                            ${reviewedAt ? `· Reviewed ${reviewedAt}` : ''}
                        </div>
                    </div>
                    <div style="text-align:right">
                        <span class="badge badge-${r.status}">${r.status}</span>
                        <div style="margin-top:6px"><span class="badge badge-${requestedRole}">requested: ${requestedRole}</span>${grantedHtml}</div>
                    </div>
                </div>

                ${r.email ? `<div class="request-field"><div class="request-field-label">Email</div><div class="request-field-value">${escapeHtml(r.email)}</div></div>` : ''}
                ${r.npub ? `<div class="request-field"><div class="request-field-label">npub</div><div class="request-field-value pubkey-cell">${escapeHtml(r.npub)}</div></div>` : ''}
                ${r.description ? `<div class="request-field"><div class="request-field-label">Description</div><div class="request-field-value">${escapeHtml(r.description)}</div></div>` : ''}
                ${linksHtml}
                ${r.admin_notes ? `<div class="request-field"><div class="request-field-label">Admin Notes</div><div class="request-field-value">${escapeHtml(r.admin_notes)}</div></div>` : ''}
                ${issuedByHtml}
                ${r.invite_code ? `<div class="request-field"><div class="request-field-label">Invite Code (${r.invite_used ? 'used' : 'unused'})</div><div class="code-display"><span class="code-text">${escapeHtml(r.invite_code)}</span><button class="copy-btn" onclick="navigator.clipboard.writeText('${r.invite_code}')">Copy</button></div></div>` : ''}

                ${status === 'pending' ? `
                    <div class="request-actions">
                        <button class="btn btn-success" onclick="openApproveModal(${r.id}, '${requestedRole}')">Approve</button>
                        <button class="btn btn-danger" onclick="openDeclineModal(${r.id})">Decline</button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    function renderLinks(linksRaw) {
        // links field is free-text — just display it
        return `<div class="request-field"><div class="request-field-label">Links</div><div class="request-field-value">${escapeHtml(linksRaw)}</div></div>`;
    }

    // ===== Approve flow =====
    function openApproveModal(id, requestedRole) {
        actionRequestId = id;
        document.getElementById('approve-notes').value = '';

        // Pre-select target_role to match what the applicant requested
        const targetSelect = document.getElementById('approve-target-role');
        const labelOpt = document.getElementById('approve-role-label');
        const isOperator = SessionManager.getRole() === 'operator';
        labelOpt.disabled = !isOperator;
        // Default selection: requested role (or fallback to artist)
        const desired = (requestedRole === 'label' && isOperator) ? 'label' : 'artist';
        targetSelect.value = desired;
        updateApproveRoleHint();
        targetSelect.onchange = updateApproveRoleHint;

        document.getElementById('approve-modal').classList.add('visible');
    }
    function updateApproveRoleHint() {
        const role = document.getElementById('approve-target-role').value;
        const hint = document.getElementById('approve-role-hint');
        hint.textContent = role === 'label'
            ? 'Onboarded as a label — they can manage their own roster of artists.'
            : 'Onboarded as an artist publishing on this node.';
    }
    function closeApproveModal() {
        document.getElementById('approve-modal').classList.remove('visible');
    }
    async function confirmApprove() {
        const btn = document.getElementById('approve-confirm-btn');
        const notes = document.getElementById('approve-notes').value;
        const targetRole = document.getElementById('approve-target-role').value;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> Approving';

        try {
            const resp = await SessionManager.authFetch(`/api/label/access-requests/${actionRequestId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admin_notes: notes, target_role: targetRole }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            const data = await resp.json();
            closeApproveModal();
            showCodeModal(data.invite_code || data.code || '');
            await loadAll();
        } catch (e) {
            showNotice('error', `Approve failed: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Approve & Generate Code';
        }
    }

    function showCodeModal(code) {
        document.getElementById('generated-code').textContent = code;
        const deepLink = code
            ? `${window.location.origin}/admin/onboarding.html?invite=${encodeURIComponent(code)}`
            : '';
        document.getElementById('generated-deep-link').textContent = deepLink;
        document.getElementById('invite-code-modal').classList.add('visible');
    }
    function closeCodeModal() {
        document.getElementById('invite-code-modal').classList.remove('visible');
    }
    function copyCode() {
        const code = document.getElementById('generated-code').textContent;
        navigator.clipboard.writeText(code).then(() => showNotice('success', 'Code copied to clipboard'));
    }
    function copyDeepLink() {
        const link = document.getElementById('generated-deep-link').textContent;
        navigator.clipboard.writeText(link).then(() => showNotice('success', 'Deep link copied to clipboard'));
    }

    // ===== Decline flow =====
    function openDeclineModal(id) {
        actionRequestId = id;
        document.getElementById('decline-notes').value = '';
        document.getElementById('decline-modal').classList.add('visible');
    }
    function closeDeclineModal() {
        document.getElementById('decline-modal').classList.remove('visible');
    }
    async function confirmDecline() {
        const btn = document.getElementById('decline-confirm-btn');
        const notes = document.getElementById('decline-notes').value;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> Declining';

        try {
            const resp = await SessionManager.authFetch(`/api/label/access-requests/${actionRequestId}/decline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admin_notes: notes }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            closeDeclineModal();
            showNotice('success', 'Request declined');
            await loadAll();
        } catch (e) {
            showNotice('error', `Decline failed: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Decline Request';
        }
    }

    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type !== 'error') setTimeout(() => { area.innerHTML = ''; }, 4000);
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    const AccessRequestsPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Reset module state for revisits
            cache = { pending: [], approved: [], declined: [] };
            activeTab = 'pending';
            actionRequestId = null;

            window.loadAll = loadAll;
            window.switchTab = switchTab;
            window.openApproveModal = openApproveModal;
            window.closeApproveModal = closeApproveModal;
            window.confirmApprove = confirmApprove;
            window.closeCodeModal = closeCodeModal;
            window.copyCode = copyCode;
            window.copyDeepLink = copyDeepLink;
            window.openDeclineModal = openDeclineModal;
            window.closeDeclineModal = closeDeclineModal;
            window.confirmDecline = confirmDecline;

            const role = SessionManager.getRole();
            if (role !== 'operator') {
                showNotice('error', 'Access Requests is operator-only. Labels: use the Artists page → Add Existing Artist to invite an artist into your roster.');
                document.getElementById('requests-container').innerHTML = '';
                return;
            }

            await loadAll();
        },

        cleanup() {
            delete window.loadAll;
            delete window.switchTab;
            delete window.openApproveModal;
            delete window.closeApproveModal;
            delete window.confirmApprove;
            delete window.closeCodeModal;
            delete window.copyCode;
            delete window.copyDeepLink;
            delete window.openDeclineModal;
            delete window.closeDeclineModal;
            delete window.confirmDecline;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['access-requests'] = AccessRequestsPage;
})();
