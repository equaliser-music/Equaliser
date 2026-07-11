/**
 * Upload Page Module
 *
 * Standalone track upload form: drag & drop audio files, per-track metadata
 * editing, cover art upload (Blossom + IPFS), save as drafts with progress
 * polling. Scoped by the selected artist (label "acting as" support).
 */
(function() {
    'use strict';

    // Track state
    let tracks = [];
    let isUploading = false;
    let coverArtCid = null;
    let coverArtBlossomHash = null;

    // Status-polling intervals (cleared on page cleanup)
    let _pollIntervals = new Set();

    // Set default release date to today
    function setDefaultDate() {
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('default-release-date').value = today;
    }

    // Handle release type change
    function onReleaseTypeChange() {
        const releaseType = document.getElementById('default-release-type').value;
        const albumGroup = document.getElementById('album-name-group');
        const albumInput = document.getElementById('default-album');

        if (releaseType === 'single') {
            albumGroup.style.display = 'none';
            albumInput.removeAttribute('required');
        } else {
            albumGroup.style.display = 'block';
            albumInput.setAttribute('required', 'required');
        }
    }

    // Load artist info from profile — seeds the upload form with the SELECTED
    // artist's Kind 0 (a label acting as Shibuya gets Shibuya's name + pricing
    // pre-filled, not the label's). The sidebar profile card stays scoped to the
    // caller via AdminSidebar._loadOwnProfile.
    async function loadArtistInfo() {
        const targetPubkey = SessionManager.getSelectedArtistPubkey();
        if (!targetPubkey) return;

        try {
            const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/relay`);

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', 'profile', {
                    kinds: [0],
                    authors: [targetPubkey],
                    limit: 1
                }]));
            };

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg[0] === 'EVENT' && msg[2]) {
                    try {
                        const profile = JSON.parse(msg[2].content);
                        const name = profile.display_name || profile.name;
                        if (name) {
                            document.getElementById('default-artist').value = name;
                        }
                        if (profile.equaliser) {
                            if (profile.equaliser.price_currency) {
                                document.getElementById('default-price-currency').value = profile.equaliser.price_currency;
                            }
                            if (profile.equaliser.default_track_price !== undefined) {
                                document.getElementById('default-price').value = profile.equaliser.default_track_price;
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing profile:', e);
                    }
                }
                if (msg[0] === 'EOSE') {
                    ws.close();
                }
            };

            ws.onerror = () => {
                console.log('Could not load profile from relay');
            };
        } catch (error) {
            console.log('Could not connect to relay:', error);
        }
    }

    // Setup upload zone drag and drop
    function setupUploadZone() {
        const uploadZone = document.getElementById('upload-zone');
        const fileInput = document.getElementById('file-input');

        uploadZone.addEventListener('click', () => {
            if (!isUploading) {
                fileInput.click();
            }
        });

        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });

        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('dragover');
        });

        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            if (!isUploading) {
                handleFiles(e.dataTransfer.files);
            }
        });

        fileInput.addEventListener('change', (e) => {
            handleFiles(e.target.files);
            fileInput.value = ''; // Reset to allow same file selection
        });
    }

    // Handle file selection
    function handleFiles(files) {
        const validTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aac', 'audio/x-m4a'];

        Array.from(files).forEach(file => {
            // Check if audio file
            if (!file.type.startsWith('audio/') && !validTypes.some(t => file.name.toLowerCase().endsWith(t.split('/')[1]))) {
                showNotification(`"${file.name}" is not a valid audio file`, 'error');
                return;
            }

            // Check for duplicates
            if (tracks.some(t => t.file.name === file.name && t.file.size === file.size)) {
                showNotification(`"${file.name}" already added`, 'error');
                return;
            }

            addTrack(file);
        });
    }

    // Add track to list
    function addTrack(file) {
        const trackId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);

        // Extract title from filename
        const filename = file.name.replace(/\.[^/.]+$/, '');
        const title = filename.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

        // Get release type and album name
        const releaseType = document.getElementById('default-release-type').value;
        const albumName = releaseType !== 'single' ? document.getElementById('default-album').value : '';

        const track = {
            id: trackId,
            file: file,
            title: title,
            artist: document.getElementById('default-artist').value || '',
            album: albumName,
            releaseType: releaseType,
            genre: document.getElementById('default-genre').value || '',
            priceAmount: parseFloat(document.getElementById('default-price').value) || 0.05,
            priceCurrency: document.getElementById('default-price-currency').value || 'USD',
            releaseDate: document.getElementById('default-release-date').value || '',
            duration: 0,
            status: 'pending',
            progress: 0,
            result: null,
            error: null
        };

        tracks.push(track);

        // Get audio duration
        const audio = new Audio();
        audio.src = URL.createObjectURL(file);
        audio.addEventListener('loadedmetadata', () => {
            track.duration = Math.round(audio.duration);
            updateTrackDisplay(track.id);
            URL.revokeObjectURL(audio.src);
        });

        renderTrackList();
        updateSubmitButton();
    }

    // Render track list
    function renderTrackList() {
        const trackList = document.getElementById('track-list');

        if (tracks.length === 0) {
            trackList.innerHTML = `
                <div class="track-list-empty">
                    No tracks added yet. Drag files above or click to browse.
                </div>
            `;
        } else {
            trackList.innerHTML = tracks.map((track, index) => `
                <div class="track-item ${track.status}" id="track-${track.id}">
                    <div class="track-number">${index + 1}</div>
                    <div class="track-info">
                        <div class="track-title">${escapeHtml(track.title)}</div>
                        <div class="track-meta">
                            <span>${escapeHtml(track.file.name)}</span>
                            <span>${track.duration > 0 ? formatDuration(track.duration) : 'Loading...'}</span>
                            <span>${formatFileSize(track.file.size)}</span>
                            ${track.album ? `<span>📀 ${escapeHtml(track.album)}</span>` : `<span style="opacity: 0.5;">Single</span>`}
                        </div>
                        ${track.status === 'uploading' || track.status === 'processing' ? `
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="progress-fill ${track.status === 'complete' ? 'complete' : ''}" style="width: ${track.progress}%"></div>
                                </div>
                            </div>
                        ` : ''}
                        ${track.result ? `
                            <div class="result-info">
                                IPFS: <code>${track.result.ipfs_manifest_cid.slice(0, 20)}...</code>
                                <br>Status: <span class="eq-draft-label">Draft (not yet released)</span>
                            </div>
                        ` : ''}
                        ${track.error ? `
                            <div class="result-info eq-danger-text">
                                Error: ${escapeHtml(track.error)}
                            </div>
                        ` : ''}
                    </div>
                    <span class="track-status ${track.status}">${getStatusText(track.status)}</span>
                    <div class="track-actions">
                        <button class="track-btn" onclick="toggleTrackEdit('${track.id}')" title="Edit" ${isUploading ? 'disabled' : ''}>
                            <svg fill="currentColor" viewBox="0 0 20 20">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/>
                            </svg>
                        </button>
                        <button class="track-btn delete" onclick="removeTrack('${track.id}')" title="Remove" ${isUploading ? 'disabled' : ''}>
                            <svg fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="track-edit-panel" id="edit-${track.id}">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Track Title</label>
                            <input type="text" class="form-input" value="${escapeHtml(track.title)}" onchange="updateTrackMeta('${track.id}', 'title', this.value)">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Artist</label>
                            <input type="text" class="form-input" value="${escapeHtml(track.artist)}" onchange="updateTrackMeta('${track.id}', 'artist', this.value)">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Release Type</label>
                            <select class="form-select" onchange="updateTrackReleaseType('${track.id}', this.value)">
                                <option value="single" ${track.releaseType === 'single' ? 'selected' : ''}>Single</option>
                                <option value="album" ${track.releaseType === 'album' ? 'selected' : ''}>Album</option>
                                <option value="ep" ${track.releaseType === 'ep' ? 'selected' : ''}>EP</option>
                            </select>
                        </div>
                        <div class="form-group" id="album-group-${track.id}" ${track.releaseType === 'single' ? 'style="display:none;"' : ''}>
                            <label class="form-label">Album/EP Name</label>
                            <input type="text" class="form-input" value="${escapeHtml(track.album)}" onchange="updateTrackMeta('${track.id}', 'album', this.value)">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Genre</label>
                            <select class="form-select" onchange="updateTrackMeta('${track.id}', 'genre', this.value)">
                                <option value="">Select genre</option>
                                <option value="electronic" ${track.genre === 'electronic' ? 'selected' : ''}>Electronic</option>
                                <option value="house" ${track.genre === 'house' ? 'selected' : ''}>House</option>
                                <option value="techno" ${track.genre === 'techno' ? 'selected' : ''}>Techno</option>
                                <option value="ambient" ${track.genre === 'ambient' ? 'selected' : ''}>Ambient</option>
                                <option value="indie" ${track.genre === 'indie' ? 'selected' : ''}>Indie</option>
                                <option value="pop" ${track.genre === 'pop' ? 'selected' : ''}>Pop</option>
                                <option value="rock" ${track.genre === 'rock' ? 'selected' : ''}>Rock</option>
                                <option value="hip-hop" ${track.genre === 'hip-hop' ? 'selected' : ''}>Hip-Hop</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Price (${track.priceCurrency})</label>
                            <input type="number" class="form-input" value="${track.priceAmount}" min="0" step="any" onchange="updateTrackMeta('${track.id}', 'priceAmount', parseFloat(this.value))">
                        </div>
                    </div>
                </div>
            `).join('');
        }

        // Update track count badge
        document.getElementById('track-count').textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;
    }

    // Update single track display
    function updateTrackDisplay(trackId) {
        const track = tracks.find(t => t.id === trackId);
        if (!track) return;

        const trackEl = document.getElementById(`track-${trackId}`);
        if (!trackEl) return;

        // Update class
        trackEl.className = `track-item ${track.status}`;

        // Update status badge
        const statusEl = trackEl.querySelector('.track-status');
        if (statusEl) {
            statusEl.className = `track-status ${track.status}`;
            statusEl.textContent = getStatusText(track.status);
        }

        // Update progress if exists
        const progressFill = trackEl.querySelector('.progress-fill');
        if (progressFill) {
            progressFill.style.width = track.progress + '%';
            if (track.status === 'complete') {
                progressFill.classList.add('complete');
            }
        }

        // Update meta display
        const metaEl = trackEl.querySelector('.track-meta');
        if (metaEl && track.duration > 0) {
            metaEl.innerHTML = `
                <span>${escapeHtml(track.file.name)}</span>
                <span>${formatDuration(track.duration)}</span>
                <span>${formatFileSize(track.file.size)}</span>
            `;
        }

        updateSubmitButton();
    }

    // Get status text
    function getStatusText(status) {
        switch (status) {
            case 'pending': return 'Ready';
            case 'uploading': return 'Uploading';
            case 'processing': return 'Processing';
            case 'complete': return 'Complete';
            case 'error': return 'Failed';
            default: return status;
        }
    }

    // Toggle track edit panel
    function toggleTrackEdit(trackId) {
        const panel = document.getElementById(`edit-${trackId}`);
        if (panel) {
            panel.classList.toggle('active');
        }
    }

    // Update track metadata
    function updateTrackMeta(trackId, field, value) {
        const track = tracks.find(t => t.id === trackId);
        if (track) {
            track[field] = value;
        }
    }

    // Update track release type (shows/hides album field)
    function updateTrackReleaseType(trackId, releaseType) {
        const track = tracks.find(t => t.id === trackId);
        if (track) {
            track.releaseType = releaseType;
            if (releaseType === 'single') {
                track.album = '';
            }
            // Show/hide album field in edit panel
            const albumGroup = document.getElementById(`album-group-${trackId}`);
            if (albumGroup) {
                albumGroup.style.display = releaseType === 'single' ? 'none' : '';
            }
            renderTrackList();
        }
    }

    // Remove track
    function removeTrack(trackId) {
        tracks = tracks.filter(t => t.id !== trackId);
        renderTrackList();
        updateSubmitButton();
    }

    // Clear all tracks
    function clearAll() {
        if (tracks.length === 0) return;
        if (isUploading) return;

        if (confirm('Remove all tracks?')) {
            tracks = [];
            renderTrackList();
            updateSubmitButton();
        }
    }

    // Update submit button state
    function updateSubmitButton() {
        const uploadBtn = document.getElementById('upload-btn');
        const summary = document.getElementById('upload-summary');

        const pendingTracks = tracks.filter(t => t.status === 'pending').length;
        const completeTracks = tracks.filter(t => t.status === 'complete').length;
        const processingTracks = tracks.filter(t => t.status === 'uploading' || t.status === 'processing').length;

        if (tracks.length === 0) {
            summary.textContent = 'No tracks ready for upload';
        } else if (isUploading) {
            summary.innerHTML = `<strong>${completeTracks}/${tracks.length}</strong> tracks uploaded (${processingTracks} processing...)`;
        } else if (completeTracks === tracks.length) {
            summary.innerHTML = `<strong>${completeTracks}</strong> tracks saved as drafts! <a href="releases.html" class="eq-link-accent">Go to Releases</a>`;
        } else {
            summary.innerHTML = `<strong>${pendingTracks}</strong> track${pendingTracks !== 1 ? 's' : ''} ready for upload`;
        }

        uploadBtn.disabled = pendingTracks === 0 || isUploading;

        if (isUploading) {
            uploadBtn.innerHTML = '<span class="loading"></span> Saving...';
        } else {
            uploadBtn.innerHTML = `
                <svg fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
                </svg>
                Save as Drafts
            `;
        }
    }

    // Upload all tracks
    async function uploadAllTracks() {
        const session = SessionManager.getSession();
        if (!session) {
            showNotification('Please log in first', 'error');
            return;
        }

        const pendingTracks = tracks.filter(t => t.status === 'pending');
        if (pendingTracks.length === 0) return;

        // Validate album name for album/EP releases
        const releaseType = document.getElementById('default-release-type').value;
        if (releaseType !== 'single') {
            const albumName = document.getElementById('default-album').value.trim();
            if (!albumName) {
                showNotification(`Please enter an ${releaseType === 'album' ? 'album' : 'EP'} name`, 'error');
                document.getElementById('default-album').focus();
                return;
            }
            // Update album name on all pending tracks in case it was changed after adding
            pendingTracks.forEach(track => {
                track.album = albumName;
                track.releaseType = releaseType;
            });
        }

        isUploading = true;
        updateSubmitButton();
        renderTrackList();

        for (const track of pendingTracks) {
            await uploadTrack(track, session);
        }

        isUploading = false;
        updateSubmitButton();
        renderTrackList();

        const completeTracks = tracks.filter(t => t.status === 'complete').length;
        const failedTracks = tracks.filter(t => t.status === 'error').length;

        if (failedTracks === 0) {
            showNotification(`${completeTracks} track${completeTracks !== 1 ? 's' : ''} saved as draft${completeTracks !== 1 ? 's' : ''}! Go to Releases to review and publish.`, 'success');
        } else {
            showNotification(`Saved ${completeTracks} as drafts, failed ${failedTracks}`, 'error');
        }
    }

    // Upload single track
    async function uploadTrack(track, session) {
        track.status = 'uploading';
        track.progress = 0;
        updateTrackDisplay(track.id);
        renderTrackList();

        try {
            // Build form data
            const formData = new FormData();
            formData.append('file', track.file);
            formData.append('title', track.title);
            formData.append('artist', track.artist || document.getElementById('default-artist').value);
            formData.append('album', track.album);
            formData.append('genre', track.genre);
            formData.append('release_date', track.releaseDate);
            formData.append('price_amount', track.priceAmount.toString());
            formData.append('price_currency', track.priceCurrency);
            formData.append('release_type', track.releaseType || 'single');
            if (coverArtCid) {
                formData.append('cover_art_cid', coverArtCid);
            }
            if (coverArtBlossomHash) {
                formData.append('blossom_cover_hash', coverArtBlossomHash);
            }
            // If a label/operator is acting on behalf of an artist (sidebar dropdown),
            // tell the orchestrator who the draft is for. /api/tracks/upload already
            // accepts target_artist_pubkey and runs ctx.can_manage(artist_pubkey).
            const targetPubkey = SessionManager.getSelectedArtistPubkey();
            if (targetPubkey && session.publicKey && targetPubkey !== session.publicKey) {
                formData.append('target_artist_pubkey', targetPubkey);
            }

            // Upload file
            const response = await SessionManager.authFetch('/api/tracks/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }

            const result = await response.json();
            track.progress = 10;
            track.status = 'processing';
            updateTrackDisplay(track.id);

            // Poll for status
            await pollTrackStatus(track, result.track_id);

        } catch (error) {
            track.status = 'error';
            track.error = error.message;
            updateTrackDisplay(track.id);
        }
    }

    // Poll for track processing status
    async function pollTrackStatus(track, trackId) {
        return new Promise((resolve) => {
            const interval = setInterval(async () => {
                try {
                    const response = await fetch(`/api/tracks/status/${trackId}`);
                    if (!response.ok) throw new Error('Failed to get status');

                    const status = await response.json();
                    track.progress = status.progress;
                    updateTrackDisplay(track.id);

                    if (status.status === 'complete') {
                        clearInterval(interval);
                        _pollIntervals.delete(interval);
                        track.result = status.result;
                        // Track is now saved as draft - no NOSTR signing needed here
                        track.status = 'complete';
                        track.progress = 100;
                        updateTrackDisplay(track.id);
                        resolve();
                    } else if (status.status === 'error') {
                        clearInterval(interval);
                        _pollIntervals.delete(interval);
                        track.status = 'error';
                        track.error = status.message;
                        updateTrackDisplay(track.id);
                        resolve();
                    }
                } catch (error) {
                    clearInterval(interval);
                    _pollIntervals.delete(interval);
                    track.status = 'error';
                    track.error = error.message;
                    updateTrackDisplay(track.id);
                    resolve();
                }
            }, 1000);
            _pollIntervals.add(interval);
        });
    }

    // Sign and publish NOSTR event using session
    async function signAndPublishEvent(unsignedEvent, session) {
        // Sign the event using the session
        const signedEvent = await session.sign({
            kind: unsignedEvent.kind,
            pubkey: unsignedEvent.pubkey,
            created_at: unsignedEvent.created_at,
            tags: unsignedEvent.tags,
            content: unsignedEvent.content
        });

        // Publish the signed event
        const response = await SessionManager.authFetch('/api/tracks/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signed_event: signedEvent })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to publish');
        }

        const result = await response.json();
        return result.event_id;
    }

    // Handle cover art upload
    async function handleCoverArtUpload(input) {
        const file = input.files[0];
        if (!file) return;

        // Validate file type
        const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!validTypes.includes(file.type)) {
            showNotification('Please upload a JPEG, PNG, or WebP image', 'error');
            input.value = '';
            return;
        }

        // Show preview
        const preview = document.getElementById('cover-art-preview');
        const reader = new FileReader();
        reader.onload = (e) => {
            preview.innerHTML = `<img src="${e.target.result}" alt="Cover art preview">`;
            preview.classList.add('has-image');
        };
        reader.readAsDataURL(file);

        // Show uploading status
        const statusEl = document.getElementById('cover-art-status');
        const statusText = document.getElementById('cover-art-status-text');
        statusEl.style.display = 'flex';
        statusEl.className = 'cover-art-status uploading';
        statusText.innerHTML = '<span class="loading"></span> Uploading cover art...';

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await SessionManager.authFetch('/api/tracks/cover-art', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }

            const result = await response.json();
            coverArtCid = result.cid;
            coverArtBlossomHash = result.blossom_hash || null;

            statusEl.className = 'cover-art-status success';
            statusText.innerHTML = `<svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg> Uploaded`;

            showNotification('Cover art uploaded successfully!', 'success');
        } catch (error) {
            coverArtCid = null;
            coverArtBlossomHash = null;
            statusEl.className = 'cover-art-status error';
            statusText.innerHTML = `<svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg> Failed: ${error.message}`;
            showNotification('Failed to upload cover art: ' + error.message, 'error');
        }

        input.value = '';
    }

    // Utility functions
    function formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    function showNotification(message, type = 'success') {
        const notification = document.getElementById('notification');
        const text = document.getElementById('notification-text');

        notification.className = `notification ${type}`;
        text.textContent = message;

        // Update icon
        const icon = notification.querySelector('.notification-icon');
        if (type === 'success') {
            icon.innerHTML = '<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>';
        } else {
            icon.innerHTML = '<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>';
        }

        notification.classList.add('show');

        setTimeout(() => {
            notification.classList.remove('show');
        }, 4000);
    }

    // Re-seed defaults when the user switches artists from the sidebar dropdown
    const onArtistSwitched = () => { loadArtistInfo(); };

    const UploadPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Reset module state (module stays loaded across revisits)
            tracks = [];
            isUploading = false;
            coverArtCid = null;
            coverArtBlossomHash = null;
            _pollIntervals = new Set();

            // Expose functions referenced by inline on*= handlers
            window.onReleaseTypeChange = onReleaseTypeChange;
            window.handleCoverArtUpload = handleCoverArtUpload;
            window.clearAll = clearAll;
            window.uploadAllTracks = uploadAllTracks;
            window.toggleTrackEdit = toggleTrackEdit;
            window.removeTrack = removeTrack;
            window.updateTrackMeta = updateTrackMeta;
            window.updateTrackReleaseType = updateTrackReleaseType;

            // Setup UI
            setupUploadZone();
            setDefaultDate();
            renderTrackList(); // Show empty state initially

            // Operators are infrastructure-only — redirect to their home (hard role separation).
            if (SessionManager.getRole() === 'operator') {
                setTimeout(() => AdminRouter.navigate('node-overview.html'), 0);
                return;
            }

            await loadArtistInfo();

            // Re-seed defaults when the user switches artists from the sidebar dropdown
            window.addEventListener('equaliser:artist-switched', onArtistSwitched);
        },

        cleanup() {
            window.removeEventListener('equaliser:artist-switched', onArtistSwitched);

            // Stop any in-flight status polling
            _pollIntervals.forEach(interval => clearInterval(interval));
            _pollIntervals.clear();

            delete window.onReleaseTypeChange;
            delete window.handleCoverArtUpload;
            delete window.clearAll;
            delete window.uploadAllTracks;
            delete window.toggleTrackEdit;
            delete window.removeTrack;
            delete window.updateTrackMeta;
            delete window.updateTrackReleaseType;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['upload'] = UploadPage;
})();
