/**
 * Settings Page Module
 *
 * Profile editor, relay management, NIP-05, account management.
 * Extracted from settings.html for use with the app shell router.
 */
(function() {
    'use strict';

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const relayUrl = `${wsProtocol}//${window.location.host}/relay`;
    const isLocalDev = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const localRelayUrl = `${wsProtocol}//${window.location.host}/relay`;

    const SettingsPage = {
        _currentProfile: {},
        _relays: [],
        _avatarBlossomUrl: null,
        _bannerBlossomUrl: null,

        init(params) {
            if (!SessionManager.hasSession()) {
                window.location.href = '/login.html?return=' + encodeURIComponent(window.location.href);
                return;
            }

            // Expose global functions for onclick handlers
            window.saveProfile = () => this._saveProfile();
            window.addRelay = () => this._addRelay();
            window.removeRelay = (i) => this._removeRelay(i);
            window.saveRelays = () => this._saveRelays();
            window.verifyNip05 = () => this._verifyNip05();
            window.copyKey = (id) => this._copyKey(id);
            window.downloadBackup = () => this._downloadBackup();
            window.handleLogout = () => this._handleLogout();
            window.handleAvatarUpload = (e) => this._handleAvatarUpload(e);
            window.handleBannerUpload = (e) => this._handleBannerUpload(e);

            const session = SessionManager.getSession();
            const npubEl = document.getElementById('account-npub');
            if (npubEl) npubEl.textContent = session.npub;
            const hintEl = document.getElementById('nip05-pubkey-hint');
            if (hintEl) hintEl.textContent = session.publicKey;

            Promise.all([this._loadProfile(), this._loadRelayList()]);
        },

        cleanup() {
            delete window.saveProfile;
            delete window.addRelay;
            delete window.removeRelay;
            delete window.saveRelays;
            delete window.verifyNip05;
            delete window.copyKey;
            delete window.downloadBackup;
            delete window.handleLogout;
            delete window.handleAvatarUpload;
            delete window.handleBannerUpload;
            this._currentProfile = {};
            this._relays = [];
            this._avatarBlossomUrl = null;
            this._bannerBlossomUrl = null;
        },

        // ===== Load Profile =====

        _loadProfile() {
            const session = SessionManager.getSession();
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                const subId = 'settings-profile-' + Math.random().toString(36).substring(7);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(); }, 8000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', subId, {
                        kinds: [0], authors: [session.publicKey], limit: 1
                    }]));
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                            this._currentProfile = JSON.parse(msg[2].content);
                            this._populateProfileForm(this._currentProfile);
                        }
                        if (msg[0] === 'EOSE') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve();
                        }
                    } catch (e) {}
                };

                ws.onerror = () => { clearTimeout(timeout); resolve(); };
            });
        },

        _populateProfileForm(profile) {
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
            setVal('edit-name', profile.display_name || profile.name || '');
            setVal('edit-bio', profile.about || '');
            setVal('edit-website', profile.website || '');
            setVal('edit-lud16', profile.lud16 || '');
            setVal('edit-nip05', profile.nip05 || '');

            // Show existing avatar
            if (profile.picture) {
                const preview = document.getElementById('avatar-preview');
                if (preview) preview.innerHTML = `<img src="${profile.picture}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<span class=\\'eq-avatar-plus-icon\\'>+</span>'">`;
            }
            // Show existing banner
            if (profile.banner) {
                const preview = document.getElementById('banner-preview');
                if (preview) preview.innerHTML = `<img src="${profile.banner}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<span class=\\'eq-banner-placeholder-text\\'>Click to upload banner</span>'">`;
            }
        },

        // ===== Image Upload =====

        async _uploadImage(file) {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/upload/image', { method: 'POST', body: formData });
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.detail || `Upload failed: ${response.status}`);
            }
            return await response.json();
        },

        async _handleAvatarUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            const preview = document.getElementById('avatar-preview');
            if (!preview) return;
            const localPreview = URL.createObjectURL(file);
            preview.innerHTML = `<img src="${localPreview}" style="width:100%;height:100%;object-fit:cover;">`;

            try {
                const result = await this._uploadImage(file);
                this._avatarBlossomUrl = result.blossom_url;
                URL.revokeObjectURL(localPreview);
                preview.innerHTML = `<img src="${this._avatarBlossomUrl}" style="width:100%;height:100%;object-fit:cover;"><span class="eq-upload-badge" style="position:absolute;bottom:4px;right:4px;font-size:10px;padding:2px 6px;">Uploaded</span>`;
            } catch (error) {
                console.error('Avatar upload error:', error);
                alert('Failed to upload avatar: ' + error.message);
            }
        },

        async _handleBannerUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            const preview = document.getElementById('banner-preview');
            if (!preview) return;
            const localPreview = URL.createObjectURL(file);
            preview.innerHTML = `<img src="${localPreview}" style="width:100%;height:100%;object-fit:cover;">`;

            try {
                const result = await this._uploadImage(file);
                this._bannerBlossomUrl = result.blossom_url;
                URL.revokeObjectURL(localPreview);
                preview.innerHTML = `<img src="${this._bannerBlossomUrl}" style="width:100%;height:100%;object-fit:cover;"><span class="eq-upload-badge" style="position:absolute;bottom:4px;right:4px;font-size:10px;padding:2px 6px;">Uploaded</span>`;
            } catch (error) {
                console.error('Banner upload error:', error);
                alert('Failed to upload banner: ' + error.message);
            }
        },

        // ===== Save Profile =====

        async _saveProfile() {
            const btn = document.getElementById('save-profile-btn');
            if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading"></span> Saving...'; }

            const session = SessionManager.getSession();
            const updatedProfile = {
                ...this._currentProfile,
                name: (document.getElementById('edit-name')?.value || '').trim(),
                display_name: (document.getElementById('edit-name')?.value || '').trim(),
                about: (document.getElementById('edit-bio')?.value || '').trim(),
                website: (document.getElementById('edit-website')?.value || '').trim(),
                lud16: (document.getElementById('edit-lud16')?.value || '').trim(),
                nip05: (document.getElementById('edit-nip05')?.value || '').trim()
            };

            // Update image URLs if new uploads were made
            if (this._avatarBlossomUrl) updatedProfile.picture = this._avatarBlossomUrl;
            if (this._bannerBlossomUrl) updatedProfile.banner = this._bannerBlossomUrl;

            const event = {
                kind: 0,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['app', 'Equaliser']],
                content: JSON.stringify(updatedProfile)
            };

            try {
                const signedEvent = await SessionManager.signEvent(event);
                const success = await this._publishEvent(signedEvent);

                if (success) {
                    this._currentProfile = updatedProfile;
                    this._showStatus('profile-status', 'Profile saved successfully', 'success');
                    if (typeof ClientSidebar !== 'undefined' && ClientSidebar.updateUserDisplay) {
                        ClientSidebar.updateUserDisplay(updatedProfile.name, updatedProfile.picture);
                    }
                } else {
                    this._showStatus('profile-status', 'Failed to publish to relay', 'error');
                }
            } catch (e) {
                this._showStatus('profile-status', 'Failed to save: ' + e.message, 'error');
            }

            if (btn) { btn.disabled = false; btn.innerHTML = 'Save Profile'; }
        },

        // ===== Relay Management =====

        _loadRelayList() {
            const session = SessionManager.getSession();
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                const subId = 'relays-' + Math.random().toString(36).substring(7);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} this._renderRelayDefaults(); resolve(); }, 8000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', subId, {
                        kinds: [10002], authors: [session.publicKey], limit: 1
                    }]));
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                            this._relays = msg[2].tags.filter(t => t[0] === 'r').map(t => t[1]);
                        }
                        if (msg[0] === 'EOSE') {
                            clearTimeout(timeout);
                            ws.close();
                            if (this._relays.length === 0) this._renderRelayDefaults();
                            else this._renderRelays();
                            resolve();
                        }
                    } catch (e) {}
                };

                ws.onerror = () => { clearTimeout(timeout); this._renderRelayDefaults(); resolve(); };
            });
        },

        _renderRelayDefaults() {
            // Use server-configured standard relays (loaded by NostrSocial.loadServerConfig)
            // instead of hardcoded public relays
            if (typeof NostrSocial !== 'undefined' && NostrSocial.DEFAULT_RELAYS) {
                this._relays = [...NostrSocial.DEFAULT_RELAYS];
            } else {
                this._relays = [localRelayUrl];
            }
            this._renderRelays();
        },

        _renderRelays() {
            const container = document.getElementById('relay-list');
            if (!container) return;
            if (this._relays.length === 0) {
                container.innerHTML = '<p class="eq-relay-hint">No relays configured</p>';
                return;
            }

            container.innerHTML = this._relays.map((url, i) => {
                const isLocal = url.includes(window.location.host);
                return `
                    <div class="relay-item">
                        <span class="relay-url">${url}</span>
                        <span class="relay-badge ${isLocal ? 'local' : 'external'}">${isLocal ? 'Local' : 'External'}</span>
                        <button class="relay-remove-btn" onclick="removeRelay(${i})" title="Remove">
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
                        </button>
                    </div>`;
            }).join('');
        },

        _addRelay() {
            const input = document.getElementById('new-relay-url');
            const url = (input?.value || '').trim();
            if (!url || (!url.startsWith('ws://') && !url.startsWith('wss://'))) {
                alert('Please enter a valid WebSocket URL (ws:// or wss://)');
                return;
            }
            if (this._relays.includes(url)) {
                alert('This relay is already in your list');
                return;
            }
            this._relays.push(url);
            this._renderRelays();
            if (input) input.value = '';
        },

        _removeRelay(index) {
            this._relays.splice(index, 1);
            this._renderRelays();
        },

        async _saveRelays() {
            const session = SessionManager.getSession();
            const event = {
                kind: 10002,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['app', 'Equaliser'], ...this._relays.map(url => ['r', url])],
                content: ''
            };

            try {
                const signedEvent = await SessionManager.signEvent(event);
                const success = await this._publishEvent(signedEvent);
                if (success) this._showStatus('relay-status', 'Relay list saved', 'success');
                else this._showStatus('relay-status', 'Failed to publish relay list', 'error');
            } catch (e) {
                this._showStatus('relay-status', 'Failed to save: ' + e.message, 'error');
            }
        },

        // ===== NIP-05 =====

        async _verifyNip05() {
            const nip05 = (document.getElementById('edit-nip05')?.value || '').trim();
            if (!nip05 || !nip05.includes('@')) {
                this._showStatus('nip05-status', 'Enter a valid NIP-05 identifier (user@domain.com)', 'error');
                return;
            }

            const [name, domain] = nip05.split('@');
            const session = SessionManager.getSession();

            try {
                const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                if (data.names && data.names[name] === session.publicKey) {
                    this._showStatus('nip05-status', 'Verified! Your NIP-05 identifier is valid.', 'success');
                } else {
                    this._showStatus('nip05-status', 'Verification failed: public key does not match.', 'error');
                }
            } catch (e) {
                this._showStatus('nip05-status', 'Could not verify: ' + e.message, 'error');
            }
        },

        // ===== Account =====

        async _copyKey(elementId) {
            const el = document.getElementById(elementId);
            const btn = el?.parentElement?.querySelector('.copy-btn');
            try {
                await navigator.clipboard.writeText(el.textContent);
                if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); }
                setTimeout(() => { if (btn) { btn.textContent = 'Copy'; btn.classList.remove('copied'); } }, 2000);
            } catch (e) {}
        },

        _downloadBackup() {
            const session = SessionManager.getSession();
            const privateKey = SessionManager.getPrivateKey();

            const backup = {
                version: 1,
                created: new Date().toISOString(),
                keys: { npub: session.npub, publicKeyHex: session.publicKey },
                profile: {
                    name: (document.getElementById('edit-name')?.value || '').trim(),
                    bio: (document.getElementById('edit-bio')?.value || '').trim()
                }
            };

            if (privateKey) {
                const nsec = NostrTools.nip19.nsecEncode(privateKey);
                backup.keys.nsec = nsec;
                backup.keys.privateKeyHex = Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join('');
            }

            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `equaliser-backup-${(backup.profile.name || 'user').toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        _handleLogout() {
            SessionManager.logout();
            window.location.href = '/home.html';
        },

        // ===== Helpers =====

        _publishEvent(signedEvent) {
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(false); }, 10000);
                ws.onopen = () => { ws.send(JSON.stringify(['EVENT', signedEvent])); };
                ws.onmessage = (e) => {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'OK') { clearTimeout(timeout); ws.close(); resolve(data[2] === true); }
                };
                ws.onerror = () => { clearTimeout(timeout); resolve(false); };
            });
        },

        _showStatus(elementId, message, type) {
            const el = document.getElementById(elementId);
            if (!el) return;
            el.textContent = message;
            el.className = `status-msg ${type}`;
            setTimeout(() => { el.className = 'status-msg'; }, 5000);
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.settings = SettingsPage;
})();
