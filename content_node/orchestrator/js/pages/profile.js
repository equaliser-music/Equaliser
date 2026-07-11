/**
 * Profile Page Module
 *
 * Edit Kind 0 profile (name, bio, avatar, banner via Blossom, socials,
 * genres, pricing preferences). Publishes to the local relay.
 */
(function() {
    'use strict';

    // Profile state
    let existingProfile = null;
    let genres = [];
    let avatarCID = null;
    let bannerCID = null;
    let avatarBlossomHash = null;
    let avatarBlossomUrl = null;
    let bannerBlossomHash = null;
    let bannerBlossomUrl = null;

    // Configuration
    const localRelayUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/relay';

    // Load profile data from session and relays
    async function loadProfileData() {
        const session = SessionManager.getSession();
        if (!session) return;

        // Check for backup profile data (from login with backup file)
        const backupProfileData = checkForBackupProfile();

        // Fetch existing profile from relays
        existingProfile = await fetchExistingProfile(session.publicKey);

        // If we have backup data and no existing profile (or backup is newer),
        // use the backup data to pre-fill
        if (backupProfileData && !existingProfile) {
            populateFormFromBackup(backupProfileData);
        } else {
            // Populate form with existing relay data
            populateForm(existingProfile);
        }

        // Update sidebar display
        updateSidebarDisplay();
    }

    // Check for backup profile data stored during login
    function checkForBackupProfile() {
        try {
            const backupData = sessionStorage.getItem('equaliser_backup_profile');
            if (backupData) {
                // Clear it after reading (one-time use)
                sessionStorage.removeItem('equaliser_backup_profile');
                return JSON.parse(backupData);
            }
        } catch (e) {
            console.warn('Failed to read backup profile data:', e);
        }
        return null;
    }

    // Populate form from backup file data
    function populateFormFromBackup(backup) {
        if (!backup) return;

        // Map backup fields to form fields
        document.getElementById('name').value = backup.name || '';
        document.getElementById('about').value = backup.bio || '';  // backup uses 'bio', profile uses 'about'
        document.getElementById('location').value = backup.location || '';

        // Handle genres
        if (backup.genres && Array.isArray(backup.genres)) {
            genres = [...backup.genres];
            renderGenres();
        }

        console.log('Profile form pre-filled from backup file');
    }

    // Fetch existing profile from local relay
    async function fetchExistingProfile(pubkeyHex) {
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

                if (profile) return profile;
            } catch (err) {
                console.log('Failed to fetch from', relayUrl, err);
            }
        }

        return null;
    }

    // Public IPFS gateway for compatibility with other NOSTR clients (used in published profiles)
    const PUBLIC_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
    // Local IPFS gateway for fast preview display (content is on local node)
    const LOCAL_IPFS_GATEWAY = `${window.location.origin}/ipfs/`;
    // Base URL for absolute Blossom URLs (cross-node display)
    const PUBLIC_BASE_URL = window.location.origin;

    // Ensure a Blossom URL is absolute for cross-node display
    function ensureAbsoluteBlossomUrl(url) {
        if (!url) return url;
        if (url.startsWith('/blossom/')) return `${PUBLIC_BASE_URL}${url}`;
        return url;
    }

    // Extract CID from any IPFS URL format
    function extractCidFromUrl(url) {
        if (!url) return null;
        const ipfsMatch = url.match(/\/ipfs\/([a-zA-Z0-9]+)/);
        return ipfsMatch ? ipfsMatch[1] : null;
    }

    // Get local gateway URL for a CID (for fast preview display)
    function getLocalGatewayUrl(cid) {
        return `${LOCAL_IPFS_GATEWAY}${cid}`;
    }

    // Populate form with existing profile data
    function populateForm(profile) {
        if (!profile) return;

        // Standard NIP-01/NIP-24 fields
        document.getElementById('name').value = profile.name || '';
        document.getElementById('about').value = profile.about || '';
        document.getElementById('website').value = profile.website || '';
        document.getElementById('nip05').value = profile.nip05 || '';
        document.getElementById('lud16').value = profile.lud16 || '';

        // Load existing images if they exist
        // Try local gateway first (fast), fall back to public gateway (for Brave compatibility)
        if (profile.picture) {
            const cid = profile.equaliser?.picture_cid || extractCidFromUrl(profile.picture);
            const localUrl = cid ? getLocalGatewayUrl(cid) : null;
            showImagePreview('avatar-preview', localUrl || profile.picture, profile.picture);
        }
        if (profile.banner) {
            const cid = profile.equaliser?.banner_cid || extractCidFromUrl(profile.banner);
            const localUrl = cid ? getLocalGatewayUrl(cid) : null;
            showImagePreview('banner-preview', localUrl || profile.banner, profile.banner);
        }

        // Equaliser-specific fields
        if (profile.equaliser) {
            document.getElementById('location').value = profile.equaliser.location || '';
            if (profile.equaliser.genres && Array.isArray(profile.equaliser.genres)) {
                genres = [...profile.equaliser.genres];
                renderGenres();
            }
            // Pricing preferences
            if (profile.equaliser.price_currency) {
                document.getElementById('price-currency').value = profile.equaliser.price_currency;
            }
            if (profile.equaliser.default_track_price !== undefined) {
                document.getElementById('default-track-price').value = profile.equaliser.default_track_price;
            }
        }
    }

    // Update sidebar display
    function updateSidebarDisplay() {
        const name = existingProfile?.name || 'New Artist';
        // Use profile.picture directly for browser compatibility (Brave blocks localhost)
        AdminSidebar.updateArtistDisplay(name, existingProfile?.picture);
    }

    // Show image preview with fallback for browsers that block localhost
    function showImagePreview(elementId, url, fallbackUrl = null) {
        const el = document.getElementById(elementId);
        const img = document.createElement('img');
        img.alt = 'Preview';

        img.onload = () => {
            el.innerHTML = '';
            el.appendChild(img);
            el.classList.add('has-image');
        };

        img.onerror = () => {
            if (fallbackUrl && fallbackUrl !== url) {
                // Try fallback URL (e.g., public gateway if local fails)
                showImagePreview(elementId, fallbackUrl, null);
            }
        };

        img.src = url;
    }

    // IPFS Image Upload via orchestrator API
    async function uploadProfileImage(file) {
        const formData = new FormData();
        formData.append('file', file);

        // Upload to Blossom via generic image upload endpoint
        const response = await fetch('/api/upload/image', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || `Upload failed: ${response.status}`);
        }

        const result = await response.json();
        return { blossom_hash: result.blossom_hash, blossom_url: result.blossom_url };
    }

    // Legacy wrapper — also upload to IPFS via cover-art endpoint for fallback CID
    async function uploadProfileImageWithIPFS(file) {
        const formData = new FormData();
        formData.append('file', file);

        // Use cover-art endpoint which uploads to both Blossom + IPFS
        const response = await SessionManager.authFetch('/api/tracks/cover-art', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || `Upload failed: ${response.status}`);
        }

        const result = await response.json();
        return {
            cid: result.cid,
            blossom_hash: result.blossom_hash,
            blossom_url: result.url,
        };
    }

    async function handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const previewEl = document.getElementById('avatar-preview');

        try {
            // Show local preview immediately
            const localPreview = URL.createObjectURL(file);
            showImagePreview('avatar-preview', localPreview);

            // Add uploading indicator
            previewEl.innerHTML += '<span class="upload-status uploading"><span class="loading" style="width:12px;height:12px;border-width:1px;"></span></span>';

            // Upload to Blossom + IPFS (artist profiles get both for resilience)
            const result = await uploadProfileImageWithIPFS(file);
            avatarCID = result.cid;
            avatarBlossomHash = result.blossom_hash;
            avatarBlossomUrl = result.blossom_url;

            // Update preview with Blossom URL and success indicator
            URL.revokeObjectURL(localPreview);
            const previewUrl = avatarBlossomUrl || getLocalGatewayUrl(avatarCID);
            showImagePreview('avatar-preview', previewUrl);
            previewEl.innerHTML += '<span class="upload-status success">&#10003;</span>';

            // Update sidebar avatar too
            const name = document.getElementById('name').value.trim() || 'Artist';
            AdminSidebar.updateArtistDisplay(name, previewUrl);

        } catch (error) {
            console.error('Avatar upload error:', error);
            previewEl.innerHTML += '<span class="upload-status error">!</span>';
            alert('Failed to upload avatar: ' + error.message);
        }
    }

    async function handleBannerUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const previewEl = document.getElementById('banner-preview');

        try {
            // Show local preview immediately
            const localPreview = URL.createObjectURL(file);
            showImagePreview('banner-preview', localPreview);

            // Add uploading indicator
            previewEl.innerHTML += '<span class="upload-status uploading"><span class="loading" style="width:12px;height:12px;border-width:1px;"></span></span>';

            // Upload to Blossom + IPFS (artist profiles get both for resilience)
            const result = await uploadProfileImageWithIPFS(file);
            bannerCID = result.cid;
            bannerBlossomHash = result.blossom_hash;
            bannerBlossomUrl = result.blossom_url;

            // Update preview with Blossom URL and success indicator
            URL.revokeObjectURL(localPreview);
            const previewUrl = bannerBlossomUrl || getLocalGatewayUrl(bannerCID);
            showImagePreview('banner-preview', previewUrl);
            previewEl.innerHTML += '<span class="upload-status success">&#10003;</span>';

        } catch (error) {
            console.error('Banner upload error:', error);
            previewEl.innerHTML += '<span class="upload-status error">!</span>';
            alert('Failed to upload banner: ' + error.message);
        }
    }

    // Genre tags
    function setupGenreInput() {
        const input = document.getElementById('genre-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const genre = input.value.trim();
                if (genre && !genres.includes(genre)) {
                    genres.push(genre);
                    renderGenres();
                }
                input.value = '';
            }
        });
    }

    function renderGenres() {
        const container = document.getElementById('genre-tags');
        container.innerHTML = genres.map((genre, i) => `
            <span class="genre-tag selected">
                ${genre}
                <span class="remove" onclick="removeGenre(${i})">×</span>
            </span>
        `).join('');
    }

    function removeGenre(index) {
        genres.splice(index, 1);
        renderGenres();
    }

    // Build profile content
    function buildProfileContent() {
        // Start with existing profile to preserve unknown fields
        // Deep copy the equaliser object to avoid reference issues
        const profile = existingProfile ? { ...existingProfile } : {};
        if (existingProfile?.equaliser) {
            profile.equaliser = { ...existingProfile.equaliser };
        }

        // Update standard fields
        profile.name = document.getElementById('name').value.trim();
        profile.about = document.getElementById('about').value.trim();
        profile.website = document.getElementById('website').value.trim();
        profile.nip05 = document.getElementById('nip05').value.trim();
        profile.lud16 = document.getElementById('lud16').value.trim();

        // Per IPFS_CID_COMPATIBILITY.md: use public gateway URLs in standard fields,
        // store raw CIDs in equaliser namespace for resilience

        // Always ensure equaliser namespace exists
        profile.equaliser = profile.equaliser || {};

        // Determine picture: prefer Blossom URL (cross-node), fall back to IPFS
        const pictureCid = avatarCID
            || profile.equaliser.picture_cid
            || extractCidFromUrl(profile.picture);
        const pictureBlossomUrl = ensureAbsoluteBlossomUrl(
            avatarBlossomUrl || profile.equaliser.picture_blossom_url
        );

        if (pictureBlossomUrl) {
            profile.picture = pictureBlossomUrl;
        } else if (pictureCid) {
            profile.picture = `${PUBLIC_IPFS_GATEWAY}${pictureCid}`;
        }
        if (pictureCid) profile.equaliser.picture_cid = pictureCid;
        if (avatarBlossomHash || profile.equaliser.picture_blossom_hash) {
            profile.equaliser.picture_blossom_hash = avatarBlossomHash || profile.equaliser.picture_blossom_hash;
        }
        if (pictureBlossomUrl) profile.equaliser.picture_blossom_url = pictureBlossomUrl;

        // Determine banner: prefer Blossom URL (cross-node), fall back to IPFS
        const bannerCid = bannerCID
            || profile.equaliser.banner_cid
            || extractCidFromUrl(profile.banner);
        const bannerBlossomUrlValue = ensureAbsoluteBlossomUrl(
            bannerBlossomUrl || profile.equaliser.banner_blossom_url
        );

        if (bannerBlossomUrlValue) {
            profile.banner = bannerBlossomUrlValue;
        } else if (bannerCid) {
            profile.banner = `${PUBLIC_IPFS_GATEWAY}${bannerCid}`;
        }
        if (bannerCid) profile.equaliser.banner_cid = bannerCid;
        if (bannerBlossomHash || profile.equaliser.banner_blossom_hash) {
            profile.equaliser.banner_blossom_hash = bannerBlossomHash || profile.equaliser.banner_blossom_hash;
        }
        if (bannerBlossomUrlValue) profile.equaliser.banner_blossom_url = bannerBlossomUrlValue;

        // Equaliser-specific fields
        const location = document.getElementById('location').value.trim();

        if (location) profile.equaliser.location = location;
        // Always save genres array (even if empty, to clear old values)
        profile.equaliser.genres = [...genres];

        // Pricing preferences
        profile.equaliser.price_currency = document.getElementById('price-currency').value;
        const defaultPrice = parseFloat(document.getElementById('default-track-price').value);
        if (!isNaN(defaultPrice) && defaultPrice >= 0) {
            profile.equaliser.default_track_price = defaultPrice;
        }

        // Preserve joinedDate if it exists, otherwise set it
        if (!profile.equaliser.joinedDate) {
            profile.equaliser.joinedDate = new Date().toISOString().split('T')[0];
        }

        return profile;
    }

    // Publish profile
    async function publishProfile() {
        const name = document.getElementById('name').value.trim();

        if (!name) {
            alert('Please enter your artist name');
            return;
        }

        // Hide previous status messages
        document.getElementById('publish-success').classList.remove('visible');
        document.getElementById('publish-error').classList.remove('visible');

        // Disable save button and show status
        const saveBtn = document.getElementById('save-btn');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="loading"></span> Saving...';

        // Show publish status container
        const statusContainer = document.getElementById('publish-status');
        statusContainer.style.display = 'block';
        statusContainer.innerHTML = `
            <div class="publish-status-item pending" id="publish-status-0">
                <span class="status-icon">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <circle cx="10" cy="10" r="6" fill="currentColor" opacity="0.3"/>
                    </svg>
                </span>
                <span class="relay-url">${localRelayUrl}</span>
                <span class="status-text">Waiting...</span>
            </div>
        `;

        // Build profile content
        const profileContent = buildProfileContent();

        // Set user-type tag from the actual role on this node — not a hardcoded "artist".
        // Drives relay denorm routing (artist → cached_artists; label/operator stay in raw_events).
        // Falls back to 'artist' if role hasn't loaded yet (defensive).
        const role = SessionManager.getRole() || 'artist';
        const tags = [['app', 'Equaliser'], ['user-type', role]];

        // Create Kind 0 event
        const event = {
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: JSON.stringify(profileContent),
            pubkey: SessionManager.getSession().publicKey
        };

        // Sign the event using session
        let signedEvent;
        try {
            signedEvent = await SessionManager.signEvent(event);
        } catch (err) {
            document.getElementById('publish-error-text').textContent = 'Failed to sign event: ' + err.message;
            document.getElementById('publish-error').classList.add('visible');
            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Save Profile';
            return;
        }

        // Publish to local relay
        const statusEl = document.getElementById('publish-status-0');

        // Update to connecting state
        statusEl.className = 'publish-status-item connecting';
        statusEl.querySelector('.status-icon').innerHTML = '<span class="loading"></span>';
        statusEl.querySelector('.status-text').textContent = 'Connecting...';

        try {
            const result = await publishToRelay(localRelayUrl, signedEvent);

            // Update status based on result
            if (result.success) {
                statusEl.className = 'publish-status-item success';
                statusEl.querySelector('.status-icon').innerHTML = `
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                    </svg>`;
                statusEl.querySelector('.status-text').textContent = 'Saved';

                // Update existingProfile with new data
                existingProfile = profileContent;
                updateSidebarDisplay();

                document.getElementById('publish-success-text').textContent = 'Profile saved successfully!';
                document.getElementById('publish-success').classList.add('visible');

                saveBtn.disabled = false;
                saveBtn.innerHTML = 'Save Profile';

                // Reset upload states
                avatarCID = null;
                bannerCID = null;
            } else {
                statusEl.className = 'publish-status-item error';
                statusEl.querySelector('.status-icon').innerHTML = `
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
                    </svg>`;
                statusEl.querySelector('.status-text').textContent = result.error;

                saveBtn.disabled = false;
                saveBtn.innerHTML = 'Retry Save';
                document.getElementById('publish-error-text').textContent = 'Failed to save profile: ' + result.error;
                document.getElementById('publish-error').classList.add('visible');
            }

        } catch (err) {
            statusEl.className = 'publish-status-item error';
            statusEl.querySelector('.status-icon').innerHTML = `
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
                </svg>`;
            statusEl.querySelector('.status-text').textContent = err.message;

            saveBtn.disabled = false;
            saveBtn.innerHTML = 'Retry Save';
            document.getElementById('publish-error-text').textContent = 'Failed to save profile: ' + err.message;
            document.getElementById('publish-error').classList.add('visible');
        }
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

    const ProfilePage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Reset module state (module stays loaded across revisits)
            existingProfile = null;
            genres = [];
            avatarCID = null;
            bannerCID = null;
            avatarBlossomHash = null;
            avatarBlossomUrl = null;
            bannerBlossomHash = null;
            bannerBlossomUrl = null;

            // Expose functions referenced by inline on*= handlers
            window.handleAvatarUpload = handleAvatarUpload;
            window.handleBannerUpload = handleBannerUpload;
            window.publishProfile = publishProfile;
            window.removeGenre = removeGenre;

            // Operators are infrastructure-only — they have no personal-artist profile to
            // edit here. Redirect them to their home page (hard role separation). Labels
            // keep access (they edit their own Kind 0 label profile).
            if (SessionManager.getRole() === 'operator') {
                setTimeout(() => AdminRouter.navigate('node-overview.html'), 0);
                return;
            }

            // Setup UI
            setupGenreInput();

            // Load profile data
            await loadProfileData();
        },

        cleanup() {
            delete window.handleAvatarUpload;
            delete window.handleBannerUpload;
            delete window.publishProfile;
            delete window.removeGenre;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['profile'] = ProfilePage;
})();
