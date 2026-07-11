/**
 * Settings Page Module
 *
 * Relay configuration (NIP-65 Kind 10002), NIP-05 verification setup,
 * NOSTR identity display/backup, and theme selection (EqTheme).
 */
(function() {
    'use strict';

    // Relay configuration
    // Each relay has: url, read (boolean), write (boolean)
    let userRelays = [];

    // Configuration
    const localRelayUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/relay';

    // Relay list is published to local relay only
    const publishRelays = [localRelayUrl];

    // Fetch artist profile for sidebar display
    async function loadArtistProfile(pubkeyHex) {
        const relaysToCheck = [localRelayUrl];

        for (const relayUrl of relaysToCheck) {
            try {
                const profile = await new Promise((resolve) => {
                    const ws = new WebSocket(relayUrl);
                    let profileData = null;

                    const timeout = setTimeout(() => {
                        ws.close();
                        resolve(null);
                    }, 5000);

                    ws.onopen = () => {
                        ws.send(JSON.stringify(['REQ', 'profile-fetch', {
                            kinds: [0],
                            authors: [pubkeyHex],
                            limit: 1
                        }]));
                    };

                    ws.onmessage = (e) => {
                        const data = JSON.parse(e.data);
                        if (data[0] === 'EVENT') {
                            try {
                                profileData = JSON.parse(data[2].content);
                            } catch (err) {
                                console.error('Error parsing profile:', err);
                            }
                        }
                        if (data[0] === 'EOSE') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(profileData);
                        }
                    };

                    ws.onerror = () => {
                        clearTimeout(timeout);
                        resolve(null);
                    };
                });

                if (profile) {
                    artistProfile = profile;
                    AdminSidebar.updateArtistDisplay(profile.name, profile.picture);
                    updateNip05Section();
                    return;
                }
            } catch (err) {
                console.log('Failed to fetch from', relayUrl, err);
            }
        }
    }

    // Fetch existing relay list (NIP-65 Kind 10002)
    async function fetchExistingRelayList(pubkeyHex) {
        const relaysToCheck = [localRelayUrl];

        for (const relayUrl of relaysToCheck) {
            try {
                const relayList = await new Promise((resolve) => {
                    const ws = new WebSocket(relayUrl);
                    let relays = null;

                    const timeout = setTimeout(() => {
                        ws.close();
                        resolve(null);
                    }, 5000);

                    ws.onopen = () => {
                        ws.send(JSON.stringify(['REQ', 'relay-list-fetch', {
                            kinds: [10002],
                            authors: [pubkeyHex],
                            limit: 1
                        }]));
                    };

                    ws.onmessage = (e) => {
                        const data = JSON.parse(e.data);
                        if (data[0] === 'EVENT') {
                            const event = data[2];
                            relays = parseRelayListEvent(event);
                        }
                        if (data[0] === 'EOSE') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(relays);
                        }
                    };

                    ws.onerror = () => {
                        clearTimeout(timeout);
                        resolve(null);
                    };
                });

                if (relayList && relayList.length > 0) {
                    userRelays = relayList;
                    return;
                }
            } catch (err) {
                console.log('Failed to fetch from', relayUrl, err);
            }
        }

        // If no relay list found, default to local relay only
        userRelays = [
            { url: localRelayUrl, read: true, write: true }
        ];
    }

    // Parse NIP-65 relay list event
    function parseRelayListEvent(event) {
        const relays = [];
        for (const tag of event.tags) {
            if (tag[0] === 'r') {
                const url = tag[1];
                const marker = tag[2];

                if (marker === 'read') {
                    relays.push({ url, read: true, write: false });
                } else if (marker === 'write') {
                    relays.push({ url, read: false, write: true });
                } else {
                    // No marker means both read and write
                    relays.push({ url, read: true, write: true });
                }
            }
        }
        return relays;
    }

    // Render relay list
    function renderRelays() {
        const container = document.getElementById('relay-list');
        container.innerHTML = userRelays.map((relay, i) => `
            <div class="relay-item">
                <span class="relay-url">${relay.url}</span>
                <span class="relay-status ${relay.read && relay.write ? 'public' : relay.read ? 'read' : 'write'}">
                    ${relay.read && relay.write ? 'Read/Write' : relay.read ? 'Read' : 'Write'}
                </span>
                <div class="relay-actions">
                    <button class="relay-action-btn" onclick="toggleRelayMode(${i})" title="Toggle read/write">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"/>
                        </svg>
                    </button>
                    <button class="relay-action-btn delete" onclick="removeRelay(${i})" title="Remove relay">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    }

    // Toggle relay read/write mode
    function toggleRelayMode(index) {
        const relay = userRelays[index];

        // Cycle through: read+write -> read only -> write only -> read+write
        if (relay.read && relay.write) {
            relay.read = true;
            relay.write = false;
        } else if (relay.read && !relay.write) {
            relay.read = false;
            relay.write = true;
        } else {
            relay.read = true;
            relay.write = true;
        }

        renderRelays();
    }

    // Remove relay
    function removeRelay(index) {
        userRelays.splice(index, 1);
        renderRelays();
    }

    // Add new relay
    function addRelay() {
        const input = document.getElementById('new-relay-input');
        let url = input.value.trim();

        if (!url) return;

        // Normalize URL
        if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            url = 'wss://' + url;
        }

        // Check if already exists
        if (userRelays.some(r => r.url === url)) {
            alert('This relay is already in your list');
            return;
        }

        // Add relay
        userRelays.push({ url, read: true, write: true });
        renderRelays();
        input.value = '';
    }

    // Build NIP-65 relay list event tags
    function buildRelayListTags() {
        const tags = [];

        for (const relay of userRelays) {
            if (relay.read && relay.write) {
                // Both read and write - no marker needed
                tags.push(['r', relay.url]);
            } else if (relay.read) {
                tags.push(['r', relay.url, 'read']);
            } else if (relay.write) {
                tags.push(['r', relay.url, 'write']);
            }
        }

        return tags;
    }

    // Publish relay list (NIP-65 Kind 10002)
    async function publishRelayList() {
        if (userRelays.length === 0) {
            alert('Please add at least one relay');
            return;
        }

        // Hide previous status messages
        document.getElementById('relay-success').classList.remove('visible');
        document.getElementById('relay-error').classList.remove('visible');

        // Disable save button
        const saveBtn = document.getElementById('save-relays-btn');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="loading"></span> Publishing...';

        // Show publish status container
        const statusContainer = document.getElementById('publish-status');
        statusContainer.style.display = 'block';
        statusContainer.innerHTML = publishRelays.map((relay, i) => `
            <div class="publish-status-item pending" id="publish-status-${i}">
                <span class="status-icon">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <circle cx="10" cy="10" r="6" fill="currentColor" opacity="0.3"/>
                    </svg>
                </span>
                <span class="relay-url">${relay}</span>
                <span class="status-text">Waiting...</span>
            </div>
        `).join('');

        // Create Kind 10002 event
        const event = {
            kind: 10002,
            created_at: Math.floor(Date.now() / 1000),
            tags: buildRelayListTags(),
            content: ''
        };

        // Sign the event using SessionManager
        let signedEvent;
        try {
            signedEvent = await SessionManager.signEvent(event);
        } catch (error) {
            console.error('Failed to sign event:', error);
            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Save Relay Configuration';
            document.getElementById('relay-error-text').textContent = 'Failed to sign event: ' + error.message;
            document.getElementById('relay-error').classList.add('visible');
            statusContainer.style.display = 'none';
            return;
        }

        // Publish to each relay
        const results = [];

        for (let i = 0; i < publishRelays.length; i++) {
            const relay = publishRelays[i];
            const statusEl = document.getElementById(`publish-status-${i}`);

            // Update to connecting state
            statusEl.className = 'publish-status-item connecting';
            statusEl.querySelector('.status-icon').innerHTML = '<span class="loading"></span>';
            statusEl.querySelector('.status-text').textContent = 'Connecting...';

            try {
                const result = await publishToRelay(relay, signedEvent);
                results.push(result);

                // Update status based on result
                if (result.success) {
                    statusEl.className = 'publish-status-item success';
                    statusEl.querySelector('.status-icon').innerHTML = `
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                        </svg>`;
                    statusEl.querySelector('.status-text').textContent = 'Published';
                } else {
                    statusEl.className = 'publish-status-item error';
                    statusEl.querySelector('.status-icon').innerHTML = `
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
                        </svg>`;
                    statusEl.querySelector('.status-text').textContent = result.error;
                }

            } catch (err) {
                results.push({ url: relay, success: false, error: err.message });
                statusEl.className = 'publish-status-item error';
                statusEl.querySelector('.status-icon').innerHTML = `
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
                    </svg>`;
                statusEl.querySelector('.status-text').textContent = err.message;
            }
        }

        // Check results
        const successCount = results.filter(r => r.success).length;

        if (successCount === 0) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Retry Save';
            document.getElementById('relay-error-text').textContent = 'Failed to publish to any relay. Please check your connection and try again.';
            document.getElementById('relay-error').classList.add('visible');
        } else {
            document.getElementById('relay-success-text').textContent = `Relay list published to ${successCount}/${results.length} relays!`;
            document.getElementById('relay-success').classList.add('visible');

            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Save Relay Configuration';
        }
    }

    // =====================================================
    // NIP-05 Verification Setup
    // =====================================================

    let artistProfile = null;  // Loaded from relay for NIP-05 address

    function parseNip05(value) {
        if (!value || !value.includes('@')) return null;
        const parts = value.split('@');
        if (parts.length !== 2) return null;
        const name = parts[0].toLowerCase().trim();
        const domain = parts[1].toLowerCase().trim();
        if (!name || !domain || !domain.includes('.')) return null;
        return { name, domain };
    }

    function getRelayUrlsForNostrJson() {
        // Use the relay list configured on this page
        return userRelays
            .filter(r => r.read || r.write)
            .map(r => r.url.replace(/^ws:\/\//, 'wss://'));
    }

    function generateNostrJson() {
        const session = SessionManager.getSession();
        if (!session) return null;

        const nip05Value = artistProfile?.nip05;
        const nip05 = parseNip05(nip05Value);
        if (!nip05) return null;

        const pubkeyHex = session.publicKey;
        const relayUrls = getRelayUrlsForNostrJson();

        const result = {
            names: {
                [nip05.name]: pubkeyHex
            }
        };

        if (relayUrls.length > 0) {
            result.relays = {
                [pubkeyHex]: relayUrls
            };
        }

        return result;
    }

    function updateNip05Section() {
        const addressEl = document.getElementById('nip05-current-address');
        const panelEl = document.getElementById('nip05-setup-panel');

        const nip05Value = artistProfile?.nip05;
        const nip05 = parseNip05(nip05Value);

        if (!nip05) {
            addressEl.innerHTML = '<p class="nip05-no-address">No NIP-05 address set. Add one in your <a href="profile.html" class="link">Profile</a> first.</p>';
            panelEl.style.display = 'none';
            return;
        }

        addressEl.innerHTML = `<p class="eq-current-address-text" style="font-size: 14px;">Current address: <strong class="eq-current-address-strong">${nip05Value}</strong></p>`;
        panelEl.style.display = 'block';

        // Update JSON preview
        const jsonObj = generateNostrJson();
        if (jsonObj) {
            document.getElementById('nip05-json-preview').textContent = JSON.stringify(jsonObj, null, 2);
        }

        // Update target URL
        document.getElementById('nip05-target-url').textContent =
            `https://${nip05.domain}/.well-known/nostr.json`;
    }

    function toggleNip05Panel() {
        const body = document.getElementById('nip05-setup-body');
        const chevron = document.getElementById('nip05-chevron');

        if (body.style.display === 'none') {
            body.style.display = 'block';
            chevron.classList.add('open');
        } else {
            body.style.display = 'none';
            chevron.classList.remove('open');
        }
    }

    function downloadNostrJson() {
        const jsonObj = generateNostrJson();
        if (!jsonObj) {
            alert('No NIP-05 address configured. Set one in your Profile first.');
            return;
        }

        const blob = new Blob([JSON.stringify(jsonObj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'nostr.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function copyNostrJson() {
        const jsonObj = generateNostrJson();
        if (!jsonObj) return;

        navigator.clipboard.writeText(JSON.stringify(jsonObj, null, 2)).then(() => {
            const btnText = document.getElementById('copy-btn-text');
            btnText.textContent = 'Copied!';
            setTimeout(() => { btnText.textContent = 'Copy'; }, 2000);
        }).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = JSON.stringify(jsonObj, null, 2);
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            const btnText = document.getElementById('copy-btn-text');
            btnText.textContent = 'Copied!';
            setTimeout(() => { btnText.textContent = 'Copy'; }, 2000);
        });
    }

    function showServerConfig(type, btn) {
        document.getElementById('nip05-nginx-config').style.display = type === 'nginx' ? 'block' : 'none';
        document.getElementById('nip05-apache-config').style.display = type === 'apache' ? 'block' : 'none';

        document.querySelectorAll('.nip05-config-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
    }

    const CHECK_PASS = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`;
    const CHECK_FAIL = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>`;
    const CHECK_LOADING = `<span class="loading" style="width:14px;height:14px;border-width:2px;"></span>`;

    function setCheckState(id, state, text) {
        const el = document.getElementById(id);
        el.className = `nip05-check ${state}`;
        el.querySelector('.nip05-check-icon').innerHTML =
            state === 'pass' ? CHECK_PASS : state === 'fail' ? CHECK_FAIL : CHECK_LOADING;
        if (text) el.querySelector('.nip05-check-text').textContent = text;
    }

    async function verifyNip05() {
        const nip05Value = artistProfile?.nip05;
        const nip05 = parseNip05(nip05Value);
        if (!nip05) {
            alert('No NIP-05 address configured. Set one in your Profile first.');
            return;
        }

        const session = SessionManager.getSession();
        if (!session) return;

        const resultsEl = document.getElementById('nip05-verify-results');
        resultsEl.style.display = 'block';

        resultsEl.querySelectorAll('.nip05-check-detail').forEach(el => el.remove());

        const verifyBtn = document.getElementById('nip05-verify-btn');
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<span class="loading" style="width:14px;height:14px;border-width:2px;"></span> Verifying...';

        setCheckState('nip05-check-accessible', 'checking', 'Checking file...');
        setCheckState('nip05-check-json', 'checking', 'Waiting...');
        setCheckState('nip05-check-name', 'checking', 'Waiting...');
        setCheckState('nip05-check-pubkey', 'checking', 'Waiting...');

        const url = `https://${nip05.domain}/.well-known/nostr.json?name=${encodeURIComponent(nip05.name)}`;

        try {
            const response = await fetch(url);

            if (!response.ok) {
                setCheckState('nip05-check-accessible', 'fail', `File not accessible (HTTP ${response.status})`);
                setCheckState('nip05-check-json', 'fail', 'Skipped');
                setCheckState('nip05-check-name', 'fail', 'Skipped');
                setCheckState('nip05-check-pubkey', 'fail', 'Skipped');
                resetVerifyBtn();
                return;
            }
            setCheckState('nip05-check-accessible', 'pass', 'File accessible (includes CORS)');

            let data;
            try {
                data = await response.json();
            } catch (e) {
                setCheckState('nip05-check-json', 'fail', 'Invalid JSON format');
                setCheckState('nip05-check-name', 'fail', 'Skipped');
                setCheckState('nip05-check-pubkey', 'fail', 'Skipped');
                resetVerifyBtn();
                return;
            }

            if (!data.names || typeof data.names !== 'object') {
                setCheckState('nip05-check-json', 'fail', 'Missing "names" object in JSON');
                setCheckState('nip05-check-name', 'fail', 'Skipped');
                setCheckState('nip05-check-pubkey', 'fail', 'Skipped');
                resetVerifyBtn();
                return;
            }
            setCheckState('nip05-check-json', 'pass', 'Valid JSON format');

            const foundPubkey = data.names[nip05.name];
            if (!foundPubkey) {
                setCheckState('nip05-check-name', 'fail', `Name "${nip05.name}" not found in response`);
                setCheckState('nip05-check-pubkey', 'fail', 'Skipped');
                resetVerifyBtn();
                return;
            }
            setCheckState('nip05-check-name', 'pass', `Name "${nip05.name}" found`);

            const expectedPubkey = session.publicKey.toLowerCase();
            if (foundPubkey.toLowerCase() === expectedPubkey) {
                setCheckState('nip05-check-pubkey', 'pass', 'Public key matches');
            } else {
                setCheckState('nip05-check-pubkey', 'fail', 'Public key does not match your identity');
                const detail = document.createElement('div');
                detail.className = 'nip05-check-detail';
                detail.textContent = `Expected: ${expectedPubkey.slice(0, 16)}... Got: ${foundPubkey.slice(0, 16)}...`;
                document.getElementById('nip05-check-pubkey').after(detail);
            }

        } catch (err) {
            setCheckState('nip05-check-accessible', 'fail', 'Cannot reach file');
            setCheckState('nip05-check-json', 'fail', 'Skipped');
            setCheckState('nip05-check-name', 'fail', 'Skipped');
            setCheckState('nip05-check-pubkey', 'fail', 'Skipped');

            const detail = document.createElement('div');
            detail.className = 'nip05-check-detail';
            detail.textContent = 'The file may not exist, CORS headers may be missing, or the domain may not support HTTPS.';
            document.getElementById('nip05-check-accessible').after(detail);
        }

        resetVerifyBtn();
    }

    function resetVerifyBtn() {
        const verifyBtn = document.getElementById('nip05-verify-btn');
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = 'Verify NIP-05';
    }

    // =====================================================
    // Backup Identity
    // =====================================================

    function downloadBackup() {
        try {
            const session = SessionManager.getSession();
            if (!session) {
                alert('No active session. Please log in first.');
                return;
            }

            const privateKey = SessionManager.getPrivateKey();
            if (!privateKey) {
                alert('Cannot backup: This session uses a browser extension. Your keys are managed by the extension.');
                return;
            }

            const privateKeyHex = Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join('');

            let nsec = null;
            try {
                const stored = sessionStorage.getItem('equaliser_session');
                if (stored) {
                    const data = JSON.parse(stored);
                    nsec = data.nsec;
                }
            } catch (e) {
                console.warn('Could not retrieve nsec from storage');
            }

            if (!nsec) {
                nsec = NostrTools.nip19.nsecEncode(privateKey);
            }

            const name = artistProfile?.name || 'artist';

            const backup = {
                version: 1,
                created: new Date().toISOString(),
                keys: {
                    nsec: nsec,
                    npub: session.npub,
                    privateKeyHex: privateKeyHex,
                    publicKeyHex: session.publicKey
                },
                profile: {
                    name: name,
                    bio: artistProfile?.about || '',
                    location: artistProfile?.equaliser?.location || '',
                    genres: artistProfile?.equaliser?.genres || []
                }
            };

            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `equaliser-backup-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Backup download failed:', err);
            alert('Failed to download backup: ' + err.message);
        }
    }

    function handleThemeChange(value) {
        if (window.EqTheme) window.EqTheme.set(value);
    }

    async function publishToRelay(relayUrl, signedEvent) {
        return new Promise((resolve) => {
            const ws = new WebSocket(relayUrl);

            const timeout = setTimeout(() => {
                ws.close();
                resolve({ url: relayUrl, success: false, error: 'Timeout' });
            }, 8000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['EVENT', signedEvent]));
            };

            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (data[0] === 'OK') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve({
                        url: relayUrl,
                        success: data[2],
                        error: data[2] ? null : data[3]
                    });
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                resolve({ url: relayUrl, success: false, error: 'Connection failed' });
            };
        });
    }

    const onNewRelayKeydown = (e) => {
        if (e.key === 'Enter') {
            addRelay();
        }
    };

    const SettingsPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Reset module state so a revisit starts clean
            userRelays = [];
            artistProfile = null;

            // Expose functions referenced by inline on*= handlers
            window.addRelay = addRelay;
            window.publishRelayList = publishRelayList;
            window.toggleRelayMode = toggleRelayMode;
            window.removeRelay = removeRelay;
            window.toggleNip05Panel = toggleNip05Panel;
            window.downloadNostrJson = downloadNostrJson;
            window.copyNostrJson = copyNostrJson;
            window.showServerConfig = showServerConfig;
            window.verifyNip05 = verifyNip05;
            window.downloadBackup = downloadBackup;
            window.handleThemeChange = handleThemeChange;

            // Get session info
            const session = SessionManager.getSession();

            // Update identity displays
            document.getElementById('user-npub-display').value = session.npub;
            document.getElementById('user-hex-display').value = session.publicKey;
            document.getElementById('session-type-display').value = session.type === 'extension' ? 'NIP-07 Browser Extension' : 'Manual (nsec)';

            // Build theme options from the single source of truth, then reflect current theme
            const themeSelect = document.getElementById('theme-select');
            if (themeSelect && window.EqTheme) {
                const themes = window.EqTheme.themes();
                themeSelect.innerHTML = '';
                themes.forEach((t) => {
                    const opt = document.createElement('option');
                    opt.value = t.id;
                    opt.textContent = t.label;
                    themeSelect.appendChild(opt);
                });
                themeSelect.value = window.EqTheme.get();
            }

            // Fetch existing relay list
            await fetchExistingRelayList(session.publicKey);

            // Render relay list
            renderRelays();

            // Fetch and update artist profile in sidebar + NIP-05 section
            await loadArtistProfile(session.publicKey);

            // Show NIP-05 section even if no profile found
            if (!artistProfile) {
                updateNip05Section();
            }

            // Handle Enter key on add relay (element is replaced on each
            // navigation, so no explicit removal needed in cleanup)
            document.getElementById('new-relay-input').addEventListener('keydown', onNewRelayKeydown);
        },

        cleanup() {
            delete window.addRelay;
            delete window.publishRelayList;
            delete window.toggleRelayMode;
            delete window.removeRelay;
            delete window.toggleNip05Panel;
            delete window.downloadNostrJson;
            delete window.copyNostrJson;
            delete window.showServerConfig;
            delete window.verifyNip05;
            delete window.downloadBackup;
            delete window.handleThemeChange;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['settings'] = SettingsPage;
})();
