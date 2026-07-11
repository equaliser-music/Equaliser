/**
 * Artist Management Page Module (label/operator)
 *
 * Roster table with role/relationship/status/fee badges, edit modal
 * (operator-only managed_by transfer), Add Existing Artist roster codes,
 * and Phase F delegation requests.
 */
(function() {
    'use strict';

    let artistsCache = [];
    let editingPubkey = null;
    let delegationsByArtist = new Set(); // pubkeys of artists with active delegation to caller

    async function loadArtists() {
        const container = document.getElementById('artists-container');
        container.innerHTML = '<div style="text-align:center; padding:40px"><span class="loading-spinner"></span></div>';

        try {
            // Fetch artists + active delegations in parallel
            const [artistsResp, delegationsResp] = await Promise.all([
                SessionManager.authFetch('/api/label/artists'),
                SessionManager.authFetch('/api/delegations/active').catch(() => null),
            ]);
            if (!artistsResp.ok) throw new Error(`HTTP ${artistsResp.status}`);
            const artistsData = await artistsResp.json();
            artistsCache = artistsData.artists || [];

            // Build a Set of artist pubkeys with active delegations to caller
            delegationsByArtist = new Set();
            if (delegationsResp && delegationsResp.ok) {
                const dData = await delegationsResp.json();
                (dData.delegations || []).forEach(d => delegationsByArtist.add(d.artist_pubkey));
            }

            renderTable(artistsCache);
        } catch (e) {
            container.innerHTML = '';
            showNotice('error', `Failed to load artists: ${e.message}`);
        }
    }

    function renderTable(artists) {
        const container = document.getElementById('artists-container');
        if (!artists.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg fill="currentColor" viewBox="0 0 20 20"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
                    <h3>No artists yet</h3>
                    <p>Approved access requests will appear here once their invite codes are used.</p>
                </div>
            `;
            return;
        }

        const role = SessionManager.getRole();
        const showManagedBy = role === 'operator';

        container.innerHTML = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Artist</th>
                        <th>Role</th>
                        <th>Relationship</th>
                        <th>Status</th>
                        <th>Fee Model</th>
                        <th>Fee Value</th>
                        ${showManagedBy ? '<th>Managed By</th>' : ''}
                        <th>Delegation</th>
                        <th>Onboarded</th>
                        <th style="text-align:right">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${artists.map(a => renderRow(a, showManagedBy)).join('')}
                </tbody>
            </table>
        `;
    }

    function renderRow(a, showManagedBy) {
        const onboardedDate = new Date(a.onboarded_at).toLocaleDateString();
        const feeValue = a.fee_model === 'percentage' ? `${a.fee_value}%`
                       : a.fee_model === 'flat_rate' ? `${a.fee_value} sats`
                       : '—';
        const shortPub = a.pubkey.slice(0, 8) + '…' + a.pubkey.slice(-4);
        const managedShort = a.managed_by ? a.managed_by.slice(0, 8) + '…' : '—';
        const isSuspended = a.status === 'suspended';
        const relType = a.relationship_type || 'managed';

        // Delegation status — only meaningful for managed artists (Phase F NIP-26 flow).
        // 'signed' artists publish via performer tag, no delegation needed.
        const isSelf = a.pubkey === SessionManager.getSession().publicKey;
        const hasDelegation = delegationsByArtist.has(a.pubkey);
        let delegationCell;
        if (a.role === 'label' || isSelf || relType === 'self' || relType === 'signed') {
            delegationCell = '<span class="eq-dim-dash">—</span>';
        } else if (hasDelegation) {
            delegationCell = '<span class="badge badge-active">active</span>';
        } else {
            delegationCell = `<button class="btn btn-small btn-secondary" onclick="openDelegationRequestModal('${a.pubkey}', '${escapeHtml(a.artist_name)}')">Request</button>`;
        }

        return `
            <tr data-pubkey="${a.pubkey}">
                <td>
                    <div class="artist-name-cell">${escapeHtml(a.artist_name)}</div>
                    <div class="pubkey-cell">${shortPub}</div>
                </td>
                <td><span class="badge badge-${a.role}">${a.role}</span></td>
                <td><span class="badge badge-relationship-${relType}">${relType}</span></td>
                <td><span class="badge badge-${a.status}">${a.status}</span></td>
                <td><span class="badge badge-${a.fee_model}">${a.fee_model}</span></td>
                <td>${feeValue}</td>
                ${showManagedBy ? `<td class="managed-by-cell">${managedShort}</td>` : ''}
                <td>${delegationCell}</td>
                <td class="eq-onboarded-cell">${onboardedDate}</td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-small btn-primary"
                                onclick="actAsAndUpload('${a.pubkey}')"
                                title="Switch the sidebar dropdown to this artist and go to Upload">
                            Upload
                        </button>
                        <button class="btn btn-small btn-secondary" onclick="openEditModal('${a.pubkey}')">Edit</button>
                        <button class="btn btn-small ${isSuspended ? 'btn-success' : 'btn-danger'}"
                                onclick="quickToggleStatus('${a.pubkey}')">
                            ${isSuspended ? 'Activate' : 'Suspend'}
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }

    function openEditModal(pubkey) {
        const a = artistsCache.find(x => x.pubkey === pubkey);
        if (!a) return;
        editingPubkey = pubkey;
        document.getElementById('edit-artist-info').innerHTML =
            `<strong>${escapeHtml(a.artist_name)}</strong><br><span class="pubkey-cell">${a.pubkey}</span>`;
        document.getElementById('edit-status').value = a.status;
        document.getElementById('edit-fee-model').value = a.fee_model;
        document.getElementById('edit-fee-value').value = a.fee_value;
        document.getElementById('edit-relationship-type').value = a.relationship_type || 'managed';
        // Managed-by transfer is operator-only — show the field when caller is operator
        const isOperator = SessionManager.getRole() === 'operator';
        document.getElementById('edit-managed-by-group').style.display = isOperator ? '' : 'none';
        document.getElementById('edit-managed-by').value = a.managed_by || '';
        onFeeModelChange();
        document.getElementById('edit-modal').classList.add('visible');
    }

    function closeEditModal() {
        document.getElementById('edit-modal').classList.remove('visible');
        editingPubkey = null;
    }

    function onFeeModelChange() {
        const model = document.getElementById('edit-fee-model').value;
        const label = document.getElementById('fee-value-label');
        const hint = document.getElementById('fee-hint');
        const input = document.getElementById('edit-fee-value');
        if (model === 'free') {
            label.textContent = 'Fee Value';
            hint.textContent = 'Free artists pay no node fees.';
            input.disabled = true;
        } else if (model === 'percentage') {
            label.textContent = 'Percentage (%)';
            hint.textContent = 'Percentage of artist revenue retained by the node.';
            input.disabled = false;
        } else {
            label.textContent = 'Flat Rate (sats/month)';
            hint.textContent = 'Fixed monthly fee in satoshis.';
            input.disabled = false;
        }
    }

    async function saveArtist() {
        if (!editingPubkey) return;
        const btn = document.getElementById('save-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> Saving';

        const body = {
            status: document.getElementById('edit-status').value,
            fee_model: document.getElementById('edit-fee-model').value,
            fee_value: parseFloat(document.getElementById('edit-fee-value').value) || 0,
            relationship_type: document.getElementById('edit-relationship-type').value,
        };
        // Operator-only: include managed_by transfer if the field is visible.
        // Empty string clears the managed_by; trimmed hex value sets it.
        if (SessionManager.getRole() === 'operator') {
            const mb = document.getElementById('edit-managed-by').value.trim();
            body.managed_by = mb;  // "" → clear, hex → set, undefined would skip
        }

        try {
            const resp = await SessionManager.authFetch(`/api/label/artists/${editingPubkey}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            showNotice('success', `Updated ${editingPubkey.slice(0, 8)}…`);
            closeEditModal();
            await loadArtists();
        } catch (e) {
            showNotice('error', `Save failed: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Changes';
        }
    }

    /**
     * Sidebar dropdown sets context; this is the per-row shortcut. Sets the
     * selected artist and navigates to upload.html, which then scopes the
     * upload form to that artist via SessionManager.getSelectedArtistPubkey().
     */
    function actAsAndUpload(pubkey) {
        try {
            SessionManager.setSelectedArtistPubkey(pubkey);
            // Broadcast so any other open tabs catch up via _attachSwitchListener.
            window.dispatchEvent(new CustomEvent('equaliser:artist-switched', {
                detail: { pubkey }
            }));
            AdminRouter.navigate('upload.html');
        } catch (e) {
            showNotice('error', `Could not switch: ${e.message}`);
        }
    }

    async function quickToggleStatus(pubkey) {
        const a = artistsCache.find(x => x.pubkey === pubkey);
        if (!a) return;
        const newStatus = a.status === 'active' ? 'suspended' : 'active';
        if (!confirm(`${newStatus === 'suspended' ? 'Suspend' : 'Reactivate'} ${a.artist_name}?`)) return;

        try {
            const resp = await SessionManager.authFetch(`/api/label/artists/${pubkey}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            showNotice('success', `${a.artist_name} is now ${newStatus}`);
            await loadArtists();
        } catch (e) {
            showNotice('error', `Status change failed: ${e.message}`);
        }
    }

    function showNotice(type, msg) {
        const area = document.getElementById('notice-area');
        area.innerHTML = `<div class="notice notice-${type}">${escapeHtml(msg)}</div>`;
        if (type !== 'error') {
            setTimeout(() => { area.innerHTML = ''; }, 4000);
        }
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    // ===== Add Existing Artist (Phase A) =====

    function openAddExistingModal() {
        document.getElementById('add-existing-name').value = '';
        document.getElementById('add-existing-npub').value = '';
        document.getElementById('add-existing-code-area').style.display = 'none';
        document.getElementById('add-existing-code-text').textContent = '';
        const btn = document.getElementById('add-existing-generate-btn');
        btn.disabled = false;
        btn.textContent = 'Generate Code';
        document.getElementById('add-existing-modal').classList.add('visible');
    }

    function closeAddExistingModal() {
        document.getElementById('add-existing-modal').classList.remove('visible');
        // If we generated a code, refresh the artists list (no immediate row but for consistency)
        loadArtists();
    }

    async function generateRosterCode() {
        const name = document.getElementById('add-existing-name').value.trim();
        if (!name) { showNotice('error', 'Artist name is required'); return; }

        const btn = document.getElementById('add-existing-generate-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> Generating';

        try {
            const body = JSON.stringify({
                artist_name: name,
                npub: document.getElementById('add-existing-npub').value.trim() || undefined,
                relationship_type: document.getElementById('add-existing-relationship').value,
            });
            const resp = await SessionManager.authFetch('/api/label/add-existing-artist', {
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
            document.getElementById('add-existing-code-text').textContent = code;
            document.getElementById('add-existing-code-area').style.display = 'block';
            btn.textContent = 'Done';
            btn.disabled = false;
            btn.onclick = closeAddExistingModal;
        } catch (e) {
            showNotice('error', `Generate failed: ${e.message}`);
            btn.disabled = false;
            btn.textContent = 'Generate Code';
        }
    }

    function copyAddExistingCode() {
        const code = document.getElementById('add-existing-code-text').textContent;
        navigator.clipboard.writeText(code).then(() => showNotice('success', 'Code copied'));
    }

    // ===== Request Delegation (Phase F) =====

    let delegationTargetPubkey = null;

    function openDelegationRequestModal(pubkey, artistName) {
        delegationTargetPubkey = pubkey;
        document.getElementById('delegation-artist-name').textContent = artistName;
        document.getElementById('delegation-duration').value = 365;
        document.getElementById('delegation-note').value = '';
        document.getElementById('kind-30050').checked = true;
        document.getElementById('kind-5').checked = true;
        const btn = document.getElementById('delegation-submit-btn');
        btn.disabled = false;
        btn.textContent = 'Send Request';
        document.getElementById('delegation-request-modal').classList.add('visible');
    }

    function closeDelegationRequestModal() {
        document.getElementById('delegation-request-modal').classList.remove('visible');
        delegationTargetPubkey = null;
    }

    async function submitDelegationRequest() {
        if (!delegationTargetPubkey) return;

        const kinds = [];
        if (document.getElementById('kind-30050').checked) kinds.push('30050');
        if (document.getElementById('kind-5').checked) kinds.push('5');
        if (kinds.length === 0) {
            showNotice('error', 'Select at least one kind');
            return;
        }

        const btn = document.getElementById('delegation-submit-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> Sending';

        try {
            const body = {
                artist_pubkey: delegationTargetPubkey,
                requested_kinds: kinds.join(','),
                duration_days: parseInt(document.getElementById('delegation-duration').value, 10) || 365,
                note: document.getElementById('delegation-note').value || '',
            };
            const resp = await SessionManager.authFetch('/api/delegations/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${resp.status}`);
            }
            showNotice('success', 'Request sent. The artist will see it in their Delegations inbox.');
            closeDelegationRequestModal();
        } catch (e) {
            showNotice('error', `Request failed: ${e.message}`);
            btn.disabled = false;
            btn.textContent = 'Send Request';
        }
    }

    const ArtistManagementPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Reset module state so a revisit starts clean
            artistsCache = [];
            editingPubkey = null;
            delegationsByArtist = new Set();
            delegationTargetPubkey = null;

            // Expose functions referenced by inline on*= handlers
            window.loadArtists = loadArtists;
            window.openEditModal = openEditModal;
            window.closeEditModal = closeEditModal;
            window.onFeeModelChange = onFeeModelChange;
            window.saveArtist = saveArtist;
            window.actAsAndUpload = actAsAndUpload;
            window.quickToggleStatus = quickToggleStatus;
            window.openAddExistingModal = openAddExistingModal;
            window.closeAddExistingModal = closeAddExistingModal;
            window.generateRosterCode = generateRosterCode;
            window.copyAddExistingCode = copyAddExistingCode;
            window.openDelegationRequestModal = openDelegationRequestModal;
            window.closeDelegationRequestModal = closeDelegationRequestModal;
            window.submitDelegationRequest = submitDelegationRequest;

            const role = SessionManager.getRole();
            if (role !== 'label' && role !== 'operator') {
                showNotice('error', 'You need a label or operator role to view this page.');
                document.getElementById('artists-container').innerHTML = '';
                return;
            }
            if (role === 'operator') {
                document.getElementById('page-description').textContent = 'All artists on this node';
            }

            await loadArtists();
        },

        cleanup() {
            delete window.loadArtists;
            delete window.openEditModal;
            delete window.closeEditModal;
            delete window.onFeeModelChange;
            delete window.saveArtist;
            delete window.actAsAndUpload;
            delete window.quickToggleStatus;
            delete window.openAddExistingModal;
            delete window.closeAddExistingModal;
            delete window.generateRosterCode;
            delete window.copyAddExistingCode;
            delete window.openDelegationRequestModal;
            delete window.closeDelegationRequestModal;
            delete window.submitDelegationRequest;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['artist-management'] = ArtistManagementPage;
})();
