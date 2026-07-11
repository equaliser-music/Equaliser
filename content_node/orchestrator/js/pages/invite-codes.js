/**
 * Invite Codes Page Module (label/operator)
 *
 * Lists unused invite codes with provenance; Generate New modal
 * (role-gated options) and copy buttons.
 */
(function() {
    'use strict';

    async function loadCodes() {
        const container = document.getElementById('codes-container');
        container.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';

        try {
            const resp = await SessionManager.authFetch('/api/label/invite-codes');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            renderTable(data.codes || []);
        } catch (e) {
            container.innerHTML = '';
            showNotice('error', `Failed to load codes: ${e.message}`);
        }
    }

    function renderTable(codes) {
        const container = document.getElementById('codes-container');
        if (!codes.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No unused invite codes</h3>
                    <p>Generate a new code or approve a pending access request.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Role</th>
                        <th>Source</th>
                        <th>Created</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${codes.map(c => renderRow(c)).join('')}
                </tbody>
            </table>
        `;
    }

    function renderRow(c) {
        const created = c.created_at ? new Date(c.created_at).toLocaleString() : '—';
        // The relay marks orphan/standalone invites with artist_name='(direct invite)' or '__orphan__'
        const isOrphan = !c.artist_name || c.artist_name === '__orphan__' || c.artist_name === '(direct invite)';
        // A roster invite ("Add Existing Artist") has a name AND a managing label.
        const isRoster = !isOrphan && c.target_managed_by;
        const source = isOrphan
            ? '<em class="eq-standalone-label">Standalone (no request)</em>'
            : isRoster
                ? `Roster invite: <strong>${escapeHtml(c.artist_name)}</strong>`
                : `Approved request: <strong>${escapeHtml(c.artist_name)}</strong>`;
        const role = c.target_role || 'artist';
        const managedSuffix = c.target_managed_by
            ? ` <span class="eq-managed-suffix">→ ${escapeHtml(c.target_managed_by.slice(0,8))}…</span>`
            : '';
        return `
            <tr>
                <td><span class="code-cell">${escapeHtml(c.invite_code)}</span></td>
                <td><span class="badge badge-${role}">${role}</span>${managedSuffix}</td>
                <td>${source}</td>
                <td class="eq-created-cell">${created}</td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-small btn-secondary" onclick="copyCode('${c.invite_code}')">Copy</button>
                    </div>
                </td>
            </tr>
        `;
    }

    function copyCode(code) {
        navigator.clipboard.writeText(code).then(() => showNotice('success', 'Code copied'));
    }

    function openGenerateModal() {
        // Disable label/operator options for non-operators
        const isOperator = SessionManager.getRole() === 'operator';
        const labelOpt = document.getElementById('gen-role-label');
        const operatorOpt = document.getElementById('gen-role-operator');
        labelOpt.disabled = !isOperator;
        operatorOpt.disabled = !isOperator;
        // Reset
        document.getElementById('gen-role').value = 'artist';
        updateRoleHint();
        document.getElementById('gen-role').onchange = updateRoleHint;
        document.getElementById('generate-modal').classList.add('visible');
    }

    function closeGenerateModal() {
        document.getElementById('generate-modal').classList.remove('visible');
    }

    function updateRoleHint() {
        const role = document.getElementById('gen-role').value;
        const hint = document.getElementById('gen-role-hint');
        hint.textContent = {
            artist: 'Artist codes onboard new artists onto this node.',
            label: 'Label codes onboard new labels (who can then manage their own roster of artists).',
            operator: '⚠ OPERATOR codes grant FULL node access — administrative powers over every artist, all data. Only generate for trusted co-operators.',
        }[role] || '';
    }

    async function confirmGenerate() {
        const role = document.getElementById('gen-role').value;
        if (role === 'operator') {
            if (!confirm('This grants full node access. Confirm generating an OPERATOR invite?')) return;
        }
        const btn = document.getElementById('gen-confirm-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> Generating';

        try {
            const body = JSON.stringify({ target_role: role });
            const resp = await SessionManager.authFetch('/api/label/invite-codes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            const data = await resp.json();
            const code = data.invite_code || data.code;
            closeGenerateModal();
            document.getElementById('new-code-text').textContent = code;
            document.getElementById('new-code-modal').classList.add('visible');
            await loadCodes();
        } catch (e) {
            showNotice('error', `Generate failed: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Generate';
        }
    }

    function closeNewCodeModal() {
        document.getElementById('new-code-modal').classList.remove('visible');
    }
    function copyNewCode() {
        navigator.clipboard.writeText(document.getElementById('new-code-text').textContent)
            .then(() => showNotice('success', 'Code copied'));
    }

    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type !== 'error') setTimeout(() => { area.innerHTML = ''; }, 4000);
    }
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    const InviteCodesPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.
            window.loadCodes = loadCodes;
            window.copyCode = copyCode;
            window.openGenerateModal = openGenerateModal;
            window.closeGenerateModal = closeGenerateModal;
            window.confirmGenerate = confirmGenerate;
            window.closeNewCodeModal = closeNewCodeModal;
            window.copyNewCode = copyNewCode;

            const role = SessionManager.getRole();
            if (role !== 'label' && role !== 'operator') {
                showNotice('error', 'You need a label or operator role to view this page.');
                document.getElementById('codes-container').innerHTML = '';
                return;
            }

            await loadCodes();
        },

        cleanup() {
            delete window.loadCodes;
            delete window.copyCode;
            delete window.openGenerateModal;
            delete window.closeGenerateModal;
            delete window.confirmGenerate;
            delete window.closeNewCodeModal;
            delete window.copyNewCode;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['invite-codes'] = InviteCodesPage;
})();
