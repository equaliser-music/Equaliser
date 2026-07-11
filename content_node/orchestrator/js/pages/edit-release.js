/**
 * Edit Release Page Module
 *
 * Edit metadata for a draft or released track. Cover art upload, add existing
 * tracks (duplicated with independent IPFS CIDs), upload new tracks, delete
 * released tracks (Kind 5 + storage cleanup). Release announcement modal.
 */
(function() {
    'use strict';

    // State
    let allTracks = [];
    let editingRelease = null;
    let editingTracks = [];
    let removedTracks = [];
    let addedTracks = [];
    let selectedTracksToAdd = [];
    let activeTrackD = null;  // d-tag of the track being moved
    let isDraftMode = false;  // Editing a draft from the database
    let draftData = null;     // Original draft data from API

    // Upload/duplicate progress polling intervals, tracked so cleanup() can
    // stop orphaned polls after navigating away mid-encode.
    const _pollTimers = new Set();

    // Load a draft from the API — scoped to the currently selected artist so labels
    // acting as a managed artist see that artist's drafts.
    async function loadDraft(draftId) {
        const targetPubkey = SessionManager.getSelectedArtistPubkey();
        if (!targetPubkey) return;

        try {
            // First, fetch the specific draft
            const response = await SessionManager.authFetch(`/api/drafts/${draftId}?pubkey=${targetPubkey}`);
            if (!response.ok) {
                const error = await response.json();
                showError(error.detail || 'Failed to load draft');
                return;
            }

            draftData = await response.json();

            // Build tracks array - for albums/EPs, we need to fetch all drafts with the same album
            let tracks = [];
            const albumName = draftData.album;
            const releaseType = draftData.release_type || 'single';

            if (albumName && releaseType !== 'single') {
                // Fetch all drafts for this artist to find ones in the same album
                // Filter by status=draft to exclude already-released tracks
                const draftStatus = draftData.status || 'draft';
                const allDraftsResponse = await SessionManager.authFetch(`/api/drafts?pubkey=${targetPubkey}&status=${draftStatus}`);
                if (allDraftsResponse.ok) {
                    const allDraftsData = await allDraftsResponse.json();
                    const albumDrafts = allDraftsData.drafts.filter(d => d.album === albumName && d.status === draftStatus);

                    // Sort by track number
                    albumDrafts.sort((a, b) => (a.track_number || 0) - (b.track_number || 0));

                    tracks = albumDrafts.map(d => ({
                        id: d.id,
                        d: d.id,
                        title: d.title,
                        artist: d.artist_name,
                        duration: d.duration,
                        manifestCid: d.ipfs_manifest_cid,
                        previewCid: d.ipfs_preview_cid,
                        priceAmount: d.price_amount,
                        priceCurrency: d.price_currency || 'USD',
                        trackNumber: d.track_number || 1,
                        blossomAudioHash: d.blossom_audio_hash || ''
                    }));
                }
            }

            // If no album tracks found (single or fetch failed), use the single draft
            if (tracks.length === 0) {
                tracks = [{
                    id: draftData.id,
                    d: draftData.id,
                    title: draftData.title,
                    artist: draftData.artist_name,
                    duration: draftData.duration,
                    manifestCid: draftData.ipfs_manifest_cid,
                    previewCid: draftData.ipfs_preview_cid,
                    priceAmount: draftData.price_amount,
                    priceCurrency: draftData.price_currency || 'USD',
                    trackNumber: draftData.track_number || 1,
                    blossomAudioHash: draftData.blossom_audio_hash || ''
                }];
            }

            // Convert draft to editing format
            editingRelease = {
                id: draftData.id,
                title: albumName || draftData.title,
                artist: draftData.artist_name,
                releaseType: releaseType,
                genre: draftData.genre || '',
                releaseDate: draftData.release_date || '',
                coverArtCid: draftData.cover_art_cid || '',
                blossomCoverHash: draftData.blossom_cover_hash || '',
                tracks: tracks,
                status: 'draft'
            };

            editingTracks = [...editingRelease.tracks];
            removedTracks = [];
            addedTracks = [];

            // Load all artist drafts so "Add Track" modal can find singles
            const allDraftsResp = await SessionManager.authFetch(`/api/drafts?pubkey=${targetPubkey}&status=draft`);
            if (allDraftsResp.ok) {
                const allDraftsData = await allDraftsResp.json();
                allTracks = allDraftsData.drafts.map(d => ({
                    id: d.id,
                    d: d.id,
                    title: d.title,
                    artist: d.artist_name,
                    duration: d.duration,
                    releaseType: d.release_type || 'single',
                    album: d.album || '',
                    priceAmount: d.price_amount,
                    priceCurrency: d.price_currency || 'USD',
                    trackNumber: d.track_number || 1,
                    blossomAudioHash: d.blossom_audio_hash || ''
                }));
            }

            document.getElementById('release-subtitle').textContent =
                `${editingRelease.title} by ${editingRelease.artist} (Draft)`;

            renderEditForm();
        } catch (error) {
            showError('Failed to load draft: ' + error.message);
        }
    }

    async function loadAllTracks() {
        // Scope by the selected artist so labels acting on someone's behalf see
        // *that* artist's catalogue (for the Add Existing Track modal).
        const targetPubkey = SessionManager.getSelectedArtistPubkey();
        if (!targetPubkey) return;

        return new Promise((resolve) => {
            const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/relay`);

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', 'tracks', {
                    kinds: [30050],
                    authors: [targetPubkey],
                    limit: 500
                }]));
            };

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg[0] === 'EVENT' && msg[2]) {
                    allTracks.push(parseTrackEvent(msg[2]));
                }
                if (msg[0] === 'EOSE') {
                    ws.close();
                    resolve();
                }
            };

            ws.onerror = () => {
                ws.close();
                resolve();
            };
        });
    }

    function parseTrackEvent(event) {
        const tags = {};
        event.tags.forEach(tag => {
            if (tag.length >= 2) {
                tags[tag[0]] = tag[1];
            }
        });

        return {
            eventId: event.id,
            pubkey: event.pubkey,
            createdAt: event.created_at,
            d: tags.d || '',
            title: tags.title || 'Untitled',
            artist: tags.artist || 'Unknown',
            album: tags.album || '',
            releaseType: tags.release_type || (tags.album ? 'album' : 'single'),
            genre: tags.genre || '',
            duration: parseInt(tags.duration) || 0,
            manifestCid: tags.ipfs_manifest_cid || '',
            previewCid: tags.ipfs_preview_cid || '',
            priceAmount: parseFloat(tags.price) || 0.05,
            priceCurrency: tags.price_currency || 'USD',
            releaseDate: tags.release_date || '',
            coverArtCid: tags.cover_art_cid || '',
            blossomCoverHash: tags.blossom_cover_hash || '',
            blossomAudioHash: tags.blossom_audio_hash || '',
            trackNumber: parseInt(tags.track_number) || 0
        };
    }

    function loadRelease(releaseId) {
        // Group tracks into release
        // Keys match releases.html format: "released:single:id" or "released:album:name"
        const releaseMap = new Map();

        allTracks.forEach(track => {
            const key = track.releaseType === 'single' || !track.album
                ? `released:single:${track.d}`
                : `released:${track.releaseType}:${track.album}`;

            if (!releaseMap.has(key)) {
                releaseMap.set(key, {
                    id: key,
                    title: track.releaseType === 'single' || !track.album ? track.title : track.album,
                    artist: track.artist,
                    releaseType: track.releaseType || 'single',
                    genre: track.genre,
                    releaseDate: track.releaseDate,
                    coverArtCid: track.coverArtCid,
                    blossomCoverHash: track.blossomCoverHash,
                    tracks: [],
                    createdAt: track.createdAt
                });
            }

            const release = releaseMap.get(key);
            release.tracks.push(track);
            if (track.coverArtCid && !release.coverArtCid) {
                release.coverArtCid = track.coverArtCid;
            }
            if (track.blossomCoverHash && !release.blossomCoverHash) {
                release.blossomCoverHash = track.blossomCoverHash;
            }
        });

        // Sort tracks within releases
        releaseMap.forEach(release => {
            release.tracks.sort((a, b) => a.trackNumber - b.trackNumber);
        });

        // Find the requested release
        editingRelease = releaseMap.get(releaseId);

        if (!editingRelease) {
            showError('Release not found');
            return;
        }

        editingTracks = editingRelease.tracks.map(t => ({...t}));
        removedTracks = [];
        addedTracks = [];

        document.getElementById('release-subtitle').textContent =
            `${editingRelease.title} by ${editingRelease.artist}`;

        renderEditForm();
    }

    function showError(message) {
        document.getElementById('content-area').innerHTML = `
            <div class="edit-section" style="text-align: center; padding: 60px;">
                <svg fill="currentColor" viewBox="0 0 20 20" class="eq-error-icon" style="width: 48px; height: 48px; margin-bottom: 16px;">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
                </svg>
                <h3 style="margin-bottom: 8px;">${message}</h3>
                <p class="eq-error-desc" style="margin-bottom: 24px;">Please go back and try again.</p>
                <a href="releases.html" class="btn btn-primary">Back to Releases</a>
            </div>
        `;
    }

    function renderEditForm() {
        const isSingle = editingRelease.releaseType === 'single';

        // Update header actions based on mode
        const headerActions = document.getElementById('header-actions');
        if (isDraftMode) {
            headerActions.innerHTML = `
                <button type="button" class="btn btn-danger" id="delete-btn" onclick="deleteDraft()">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
                    </svg>
                    Delete
                </button>
                <a href="releases.html" class="btn btn-secondary">Cancel</a>
                <button type="button" class="btn btn-primary" id="save-btn" onclick="saveDraft()">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                    </svg>
                    Save Draft
                </button>
                <button type="button" class="btn btn-release" id="release-btn" onclick="releaseDraft()">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clip-rule="evenodd"/>
                    </svg>
                    Release
                </button>
            `;
        } else {
            headerActions.innerHTML = `
                <button type="button" class="btn btn-danger" id="delete-btn" onclick="deleteRelease()">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
                    </svg>
                    Delete Release
                </button>
                <a href="releases.html" class="btn btn-secondary">Back</a>
            `;
        }

        document.getElementById('content-area').innerHTML = `
            ${isDraftMode ? `
                <div class="draft-banner">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                    </svg>
                    <div class="draft-banner-text">
                        <div class="draft-banner-title">This is a Draft</div>
                        <div class="draft-banner-description">This track hasn't been published yet. Make any changes, then click "Release" to publish to NOSTR.</div>
                    </div>
                </div>
            ` : ''}

            <!-- Release Details -->
            <div class="edit-section">
                <div class="section-header">
                    <h2 class="section-title">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                        </svg>
                        Release Details
                    </h2>
                </div>

                <div class="cover-section">
                    <div class="cover-preview" id="cover-preview" onclick="document.getElementById('cover-input').click()">
                        ${(() => {
                            const coverUrl = editingRelease.blossomCoverHash
                                ? `/blossom/${editingRelease.blossomCoverHash}`
                                : editingRelease.coverArtCid ? `/ipfs/${editingRelease.coverArtCid}` : null;
                            return coverUrl
                                ? `<img src="${coverUrl}" alt="Cover">`
                                : `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clip-rule="evenodd"/></svg>`;
                        })()}
                    </div>
                    <input type="file" id="cover-input" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="handleCoverUpload(event)">
                    <input type="hidden" id="cover-cid" value="${editingRelease.coverArtCid || ''}">
                    <input type="hidden" id="cover-blossom-hash" value="${editingRelease.blossomCoverHash || ''}">
                    <div class="cover-info">
                        <h4>Cover Art</h4>
                        <p>Click to upload a new cover image. Recommended size: 1000x1000px. Formats: JPEG, PNG, WebP.</p>
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('cover-input').click()">
                            <svg fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
                            </svg>
                            Upload Cover
                        </button>
                    </div>
                </div>
            </div>

            <!-- Metadata -->
            <div class="edit-section">
                <div class="section-header">
                    <h2 class="section-title">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5c.256 0 .512.098.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/>
                        </svg>
                        Metadata
                    </h2>
                </div>

                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Title</label>
                        <input type="text" class="form-input" id="release-title" value="${escapeHtml(editingRelease.title)}" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Artist</label>
                        <input type="text" class="form-input" id="release-artist" value="${escapeHtml(editingRelease.artist)}" required>
                    </div>
                </div>

                <div class="form-row form-row-3">
                    <div class="form-group">
                        <label class="form-label">Release Type</label>
                        <select class="form-select" id="release-type" onchange="handleReleaseTypeChange()">
                            <option value="album" ${editingRelease.releaseType === 'album' ? 'selected' : ''}>Album</option>
                            <option value="ep" ${editingRelease.releaseType === 'ep' ? 'selected' : ''}>EP</option>
                            <option value="single" ${editingRelease.releaseType === 'single' ? 'selected' : ''}>Single</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Genre</label>
                        <select class="form-select" id="release-genre">
                            <option value="">Select genre</option>
                            <option value="electronic" ${editingRelease.genre === 'electronic' ? 'selected' : ''}>Electronic</option>
                            <option value="house" ${editingRelease.genre === 'house' ? 'selected' : ''}>House</option>
                            <option value="techno" ${editingRelease.genre === 'techno' ? 'selected' : ''}>Techno</option>
                            <option value="ambient" ${editingRelease.genre === 'ambient' ? 'selected' : ''}>Ambient</option>
                            <option value="indie" ${editingRelease.genre === 'indie' ? 'selected' : ''}>Indie</option>
                            <option value="pop" ${editingRelease.genre === 'pop' ? 'selected' : ''}>Pop</option>
                            <option value="rock" ${editingRelease.genre === 'rock' ? 'selected' : ''}>Rock</option>
                            <option value="hip-hop" ${editingRelease.genre === 'hip-hop' ? 'selected' : ''}>Hip-Hop</option>
                            <option value="r-and-b" ${editingRelease.genre === 'r-and-b' ? 'selected' : ''}>R&B</option>
                            <option value="jazz" ${editingRelease.genre === 'jazz' ? 'selected' : ''}>Jazz</option>
                            <option value="classical" ${editingRelease.genre === 'classical' ? 'selected' : ''}>Classical</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Release Date</label>
                        <input type="date" class="form-input" id="release-date" value="${editingRelease.releaseDate || ''}">
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label">Description</label>
                    <textarea class="form-textarea" id="release-description" placeholder="Tell the story behind this release...">${editingRelease.description || ''}</textarea>
                </div>
            </div>

            <!-- Tracklist (for albums/EPs) -->
            <div class="edit-section" id="tracklist-section" style="${isSingle ? 'display:none' : ''}">
                <div class="section-header">
                    <h2 class="section-title">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"/>
                        </svg>
                        Tracklist
                    </h2>
                </div>

                <div class="tracklist-header">
                    <span class="col-move"></span>
                    <span class="col-num">#</span>
                    <span class="col-title">Title</span>
                    <span class="col-duration">Duration</span>
                    <span class="col-price">Price</span>
                    <span class="col-actions"></span>
                </div>
                <div class="tracklist-editor" id="tracklist-editor"></div>
                <div style="display:flex;gap:8px;margin-top:16px;">
                    <button type="button" class="add-track-btn" onclick="openAddTrackModal()">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
                        </svg>
                        Add Existing Track
                    </button>
                    <button type="button" class="add-track-btn" onclick="document.getElementById('upload-track-input').click()">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
                        </svg>
                        Upload New Track
                    </button>
                    <input type="file" id="upload-track-input" accept="audio/*" multiple style="display:none;" onchange="handleTrackUpload(event)">
                </div>
            </div>
        `;

        renderTracklist();
    }

    function renderTracklist() {
        const container = document.getElementById('tracklist-editor');
        if (!container) return;

        if (editingTracks.length === 0) {
            container.innerHTML = '<div class="tracklist-empty">No tracks in this release. Add tracks using the button below.</div>';
            return;
        }

        container.innerHTML = editingTracks.map((track, index) => `
            <div class="tracklist-row${activeTrackD === track.d ? ' active-track' : ''}" data-index="${index}" data-d="${track.d}">
                <div class="col-move">
                    <button type="button" class="move-btn" onclick="moveTrack(${index}, -1)" ${index === 0 ? 'disabled' : ''} title="Move up">
                        <svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>
                    </button>
                    <button type="button" class="move-btn" onclick="moveTrack(${index}, 1)" ${index === editingTracks.length - 1 ? 'disabled' : ''} title="Move down">
                        <svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
                    </button>
                </div>
                <span class="col-num">${index + 1}</span>
                <div class="col-title">
                    <input type="text" class="track-title-input" value="${escapeHtml(track.title)}"
                           oninput="updateTrackField('${track.d}', 'title', this.value)">
                </div>
                <span class="col-duration">${formatDuration(track.duration)}</span>
                <div class="col-price">
                    <input type="number" class="price-input" value="${track.priceAmount}" min="0" step="any"
                           oninput="updateTrackField('${track.d}', 'priceAmount', parseFloat(this.value) || 0)">
                    <span class="price-label">${track.priceCurrency}</span>
                </div>
                <div class="col-actions">
                    <button type="button" class="remove-btn" onclick="removeTrack('${track.d}')" title="Remove from release">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    }

    function handleReleaseTypeChange() {
        const type = document.getElementById('release-type').value;
        const tracklistSection = document.getElementById('tracklist-section');
        if (type === 'single') {
            tracklistSection.style.display = 'none';
        } else {
            tracklistSection.style.display = 'block';
        }
    }

    function updateTrackField(trackD, field, value) {
        const track = editingTracks.find(t => t.d === trackD);
        if (track) {
            track[field] = value;
        }
    }

    function removeTrack(trackD) {
        const trackIndex = editingTracks.findIndex(t => t.d === trackD);
        if (trackIndex === -1) return;

        const track = editingTracks[trackIndex];
        removedTracks.push(track);
        editingTracks.splice(trackIndex, 1);
        renderTracklist();
    }

    // Move track up or down by swapping DOM rows in place
    function moveTrack(index, direction) {
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= editingTracks.length) return;

        const container = document.getElementById('tracklist-editor');
        const rows = container.children;
        const movingRow = rows[index];
        const swapRow = rows[newIndex];

        // Swap in the data array
        const track = editingTracks[index];
        activeTrackD = track.d;
        editingTracks.splice(index, 1);
        editingTracks.splice(newIndex, 0, track);

        // Swap DOM nodes - insert the moving row before or after the swap row
        if (direction === -1) {
            container.insertBefore(movingRow, swapRow);
        } else {
            container.insertBefore(movingRow, swapRow.nextSibling);
        }

        // Update track numbers and button states for just the two swapped rows
        updateRowState(movingRow, newIndex);
        updateRowState(swapRow, index);

        // Update highlight
        movingRow.classList.add('active-track');
        swapRow.classList.remove('active-track');

        movingRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Update a row's track number and button disabled states after a swap
    function updateRowState(row, index) {
        row.dataset.index = index;
        row.querySelector('.col-num').textContent = index + 1;

        const buttons = row.querySelectorAll('.move-btn');
        const upBtn = buttons[0];
        const downBtn = buttons[1];

        upBtn.disabled = (index === 0);
        upBtn.onclick = () => moveTrack(index, -1);
        downBtn.disabled = (index === editingTracks.length - 1);
        downBtn.onclick = () => moveTrack(index, 1);
    }

    // Click anywhere outside move buttons to deselect
    const onDocumentClick = (e) => {
        if (!e.target.closest('.move-btn') && activeTrackD) {
            activeTrackD = null;
            renderTracklist();
        }
    };

    // Add Track Modal
    function openAddTrackModal() {
        selectedTracksToAdd = [];
        renderAvailableTracks();

        const searchInput = document.getElementById('add-track-search');
        searchInput.value = '';
        searchInput.oninput = () => renderAvailableTracks(searchInput.value.toLowerCase());

        document.getElementById('add-track-modal').classList.add('active');
    }

    function closeAddTrackModal() {
        document.getElementById('add-track-modal').classList.remove('active');
        selectedTracksToAdd = [];
    }

    function renderAvailableTracks(searchFilter = '') {
        const container = document.getElementById('add-track-list');
        const currentTrackIds = editingTracks.map(t => t.d);
        const currentBlossomHashes = editingTracks
            .map(t => t.blossomAudioHash)
            .filter(h => h);

        const availableTracks = allTracks.filter(track => {
            const notInCurrentRelease = !currentTrackIds.includes(track.d);
            const notAlreadyAdded = !addedTracks.find(t => t.d === track.d);
            const audioNotInRelease = !track.blossomAudioHash || !currentBlossomHashes.includes(track.blossomAudioHash);
            const matchesSearch = !searchFilter || track.title.toLowerCase().includes(searchFilter);
            return notInCurrentRelease && notAlreadyAdded && audioNotInRelease && matchesSearch;
        });

        if (availableTracks.length === 0) {
            container.innerHTML = '<div class="no-tracks-available">No tracks available to add.</div>';
            return;
        }

        container.innerHTML = availableTracks.map(track => `
            <div class="add-track-item ${selectedTracksToAdd.includes(track.d) ? 'selected' : ''}"
                 onclick="toggleTrackSelection('${track.d}')">
                <div class="add-track-info">
                    <div class="add-track-title">${escapeHtml(track.title)}</div>
                    <div class="add-track-meta">${formatDuration(track.duration)} · ${track.priceAmount} ${track.priceCurrency}</div>
                </div>
                <div class="add-track-check">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                    </svg>
                </div>
            </div>
        `).join('');
    }

    function toggleTrackSelection(trackD) {
        const index = selectedTracksToAdd.indexOf(trackD);
        if (index === -1) {
            selectedTracksToAdd.push(trackD);
        } else {
            selectedTracksToAdd.splice(index, 1);
        }
        renderAvailableTracks(document.getElementById('add-track-search').value.toLowerCase());
    }

    async function confirmAddTracks() {
        if (selectedTracksToAdd.length === 0) {
            showNotification('No tracks selected', 'error');
            return;
        }

        // Disable buttons during duplication
        const addBtn = document.querySelector('#add-track-modal .btn-primary');
        const cancelBtn = document.querySelector('#add-track-modal .btn-secondary');
        const closeBtn = document.querySelector('#add-track-modal .modal-close');
        addBtn.disabled = true;
        addBtn.textContent = 'Duplicating...';
        cancelBtn.disabled = true;
        closeBtn.style.display = 'none';

        // Show progress UI in modal
        const container = document.getElementById('add-track-list');
        const searchInput = document.getElementById('add-track-search');
        searchInput.style.display = 'none';

        container.innerHTML = selectedTracksToAdd.map(trackD => {
            const track = allTracks.find(t => t.d === trackD);
            return `<div class="add-track-item" id="dup-${trackD}" style="cursor:default;">
                <div class="add-track-info" style="width:100%;">
                    <div class="add-track-title">${escapeHtml(track.title)}</div>
                    <div class="add-track-meta" id="dup-msg-${trackD}">Waiting...</div>
                    <div class="eq-dup-track" style="height:4px;margin-top:8px;overflow:hidden;">
                        <div id="dup-bar-${trackD}" class="eq-dup-bar" style="width:0%;height:100%;"></div>
                    </div>
                </div>
            </div>`;
        }).join('');

        // Duplicate each track sequentially
        let successCount = 0;
        for (const trackD of selectedTracksToAdd) {
            const sourceTrack = allTracks.find(t => t.d === trackD);
            try {
                const result = await duplicateTrack(sourceTrack);
                const trackCopy = {
                    id: result.draft_id,
                    d: result.draft_id,
                    title: sourceTrack.title,
                    artist: sourceTrack.artist,
                    duration: result.duration,
                    manifestCid: result.ipfs_manifest_cid,
                    previewCid: result.ipfs_preview_cid,
                    priceAmount: sourceTrack.priceAmount,
                    priceCurrency: sourceTrack.priceCurrency,
                    trackNumber: editingTracks.length + 1
                };
                editingTracks.push(trackCopy);
                addedTracks.push(trackCopy);
                successCount++;

                // Mark as done in modal
                const msgEl = document.getElementById(`dup-msg-${trackD}`);
                if (msgEl) msgEl.textContent = 'Done';
            } catch (e) {
                const msgEl = document.getElementById(`dup-msg-${trackD}`);
                if (msgEl) msgEl.textContent = 'Failed: ' + e.message;
                console.error(`Failed to duplicate ${sourceTrack.title}:`, e);
            }
        }

        // Restore modal state
        searchInput.style.display = '';
        addBtn.disabled = false;
        addBtn.textContent = 'Add Selected';
        cancelBtn.disabled = false;
        closeBtn.style.display = '';

        closeAddTrackModal();
        renderTracklist();
        if (successCount > 0) {
            showNotification(`Added ${successCount} track(s)`, 'success');
        } else {
            showNotification('Failed to add tracks', 'error');
        }
    }

    async function duplicateTrack(sourceTrack) {
        const response = await SessionManager.authFetch('/api/tracks/duplicate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_draft_id: sourceTrack.id })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to start duplication');
        }
        const { track_id } = await response.json();

        return new Promise((resolve, reject) => {
            const interval = setInterval(async () => {
                try {
                    const statusResp = await fetch(`/api/tracks/status/${track_id}`);
                    if (!statusResp.ok) throw new Error('Status check failed');
                    const status = await statusResp.json();

                    // Update progress bar
                    const bar = document.getElementById(`dup-bar-${sourceTrack.d}`);
                    if (bar) bar.style.width = status.progress + '%';
                    const msg = document.getElementById(`dup-msg-${sourceTrack.d}`);
                    if (msg) msg.textContent = status.message;

                    if (status.status === 'complete') {
                        clearInterval(interval);
                        _pollTimers.delete(interval);
                        resolve(status.result);
                    } else if (status.status === 'error') {
                        clearInterval(interval);
                        _pollTimers.delete(interval);
                        reject(new Error(status.message));
                    }
                } catch (e) {
                    clearInterval(interval);
                    _pollTimers.delete(interval);
                    reject(e);
                }
            }, 1000);
            _pollTimers.add(interval);
        });
    }

    // Upload new track(s) directly into this release
    async function handleTrackUpload(event) {
        const files = Array.from(event.target.files);
        if (!files.length) return;

        const session = SessionManager.getSession();
        if (!session) {
            showNotification('Not logged in', 'error');
            return;
        }

        const artist = document.getElementById('release-artist')?.value || editingRelease?.artist || '';

        for (const file of files) {
            // Derive title from filename (strip extension)
            const title = file.name.replace(/\.[^/.]+$/, '');

            showNotification(`Uploading "${title}"...`, 'success');

            try {
                // Upload via tracks API
                const formData = new FormData();
                formData.append('file', file);
                formData.append('title', title);
                formData.append('artist', artist);

                const response = await SessionManager.authFetch('/api/tracks/upload', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.detail || 'Upload failed');
                }

                const result = await response.json();
                const trackId = result.track_id;

                // Poll for completion
                const draftResult = await new Promise((resolve, reject) => {
                    const interval = setInterval(async () => {
                        try {
                            const statusResp = await fetch(`/api/tracks/status/${trackId}`);
                            if (!statusResp.ok) throw new Error('Status check failed');
                            const status = await statusResp.json();

                            if (status.status === 'complete') {
                                clearInterval(interval);
                                _pollTimers.delete(interval);
                                resolve(status.result);
                            } else if (status.status === 'error') {
                                clearInterval(interval);
                                _pollTimers.delete(interval);
                                reject(new Error(status.message));
                            }
                        } catch (e) {
                            clearInterval(interval);
                            _pollTimers.delete(interval);
                            reject(e);
                        }
                    }, 1000);
                    _pollTimers.add(interval);
                });

                // Add to tracklist
                const trackCopy = {
                    id: draftResult.draft_id,
                    d: draftResult.draft_id,
                    title: draftResult.title,
                    artist: draftResult.artist,
                    duration: draftResult.duration,
                    manifestCid: draftResult.ipfs_manifest_cid,
                    previewCid: draftResult.ipfs_preview_cid,
                    priceAmount: editingRelease?.tracks?.[0]?.priceAmount || 0.05,
                    priceCurrency: editingRelease?.tracks?.[0]?.priceCurrency || 'USD',
                    trackNumber: editingTracks.length + 1,
                    blossomAudioHash: draftResult.blossom_audio_hash || ''
                };
                editingTracks.push(trackCopy);
                addedTracks.push(trackCopy);
                renderTracklist();
                showNotification(`Added "${draftResult.title}"`, 'success');

            } catch (e) {
                showNotification(`Failed to upload "${title}": ${e.message}`, 'error');
                console.error('Track upload failed:', e);
            }
        }

        // Reset file input so the same file can be selected again
        event.target.value = '';
    }

    // Cover Upload
    async function handleCoverUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const preview = document.getElementById('cover-preview');
        const saveBtn = document.getElementById('save-btn');

        preview.innerHTML = '<div class="loading-spinner" style="width:32px;height:32px;"></div>';
        saveBtn.disabled = true;

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await SessionManager.authFetch('/api/tracks/cover-art', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Upload failed');

            const result = await response.json();
            const coverUrl = result.blossom_hash
                ? `/blossom/${result.blossom_hash}`
                : `/ipfs/${result.cid}`;
            preview.innerHTML = `<img src="${coverUrl}" alt="Cover">`;
            document.getElementById('cover-cid').value = result.cid;
            document.getElementById('cover-blossom-hash').value = result.blossom_hash || '';
            showNotification('Cover art uploaded', 'success');

        } catch (error) {
            preview.innerHTML = `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clip-rule="evenodd"/></svg>`;
            showNotification('Failed to upload cover: ' + error.message, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    }

    // Save Release
    async function saveRelease() {
        const session = SessionManager.getSession();
        if (!session) {
            showNotification('Not logged in', 'error');
            return;
        }

        const newTitle = document.getElementById('release-title').value;
        const newArtist = document.getElementById('release-artist').value;
        const newType = document.getElementById('release-type').value;
        const newGenre = document.getElementById('release-genre').value;
        const newDate = document.getElementById('release-date').value;
        const newCoverCid = document.getElementById('cover-cid').value;
        const newBlossomCoverHash = document.getElementById('cover-blossom-hash').value;

        if (!newTitle || !newArtist) {
            showNotification('Title and artist are required', 'error');
            return;
        }

        const saveBtn = document.getElementById('save-btn');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div> Saving...';

        try {
            // Update tracks in release
            for (let i = 0; i < editingTracks.length; i++) {
                const track = editingTracks[i];
                const tags = [
                    ['d', track.d],
                    ['app', 'Equaliser'],
                    ['title', track.title],
                    ['artist', newArtist],
                    ['duration', track.duration.toString()],
                    ['ipfs_manifest_cid', track.manifestCid],
                    ['ipfs_preview_cid', track.previewCid],
                    ['price', track.priceAmount.toString()],
                    ['price_currency', track.priceCurrency],
                    ['release_type', newType],
                    ['track_number', (i + 1).toString()]
                ];

                if (newType !== 'single') {
                    tags.push(['album', newTitle]);
                }
                if (newGenre) tags.push(['genre', newGenre]);
                if (newDate) tags.push(['release_date', newDate]);
                if (newCoverCid) tags.push(['cover_art_cid', newCoverCid]);
                if (newBlossomCoverHash) tags.push(['blossom_cover_hash', newBlossomCoverHash]);

                await publishTrackEvent(session, tags);
            }

            // Convert removed tracks to singles
            for (const track of removedTracks) {
                const tags = [
                    ['d', track.d],
                    ['app', 'Equaliser'],
                    ['title', track.title],
                    ['artist', track.artist],
                    ['duration', track.duration.toString()],
                    ['ipfs_manifest_cid', track.manifestCid],
                    ['ipfs_preview_cid', track.previewCid],
                    ['price', track.priceAmount.toString()],
                    ['price_currency', track.priceCurrency],
                    ['release_type', 'single']
                ];

                if (track.genre) tags.push(['genre', track.genre]);
                if (track.releaseDate) tags.push(['release_date', track.releaseDate]);
                if (track.coverArtCid) tags.push(['cover_art_cid', track.coverArtCid]);

                await publishTrackEvent(session, tags);
            }

            showNotification('Release saved successfully', 'success');

            // Redirect back to releases page
            setTimeout(() => {
                AdminRouter.navigate('releases.html');
            }, 1000);

        } catch (error) {
            showNotification('Failed to save: ' + error.message, 'error');
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Save Changes`;
        }
    }

    async function publishTrackEvent(session, tags, artistPubkey) {
        // artistPubkey defaults to caller for self-publish; pass the artist's pubkey to
        // route through Phase F (managed) or Phase G (signed) on-behalf-of flows.
        const targetArtist = artistPubkey || session.publicKey;
        const unsignedEvent = {
            kind: 30050,
            pubkey: targetArtist,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: ''
        };

        const signedEvent = await signTrackEvent(unsignedEvent, targetArtist, session.publicKey);

        const response = await SessionManager.authFetch('/api/tracks/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signed_event: signedEvent })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Failed to publish track event');
        }

        return response.json();
    }

    /**
     * 3-way sign router (mirror of releases.html signTrackEvent).
     *
     * - Self-publish (artist === caller): sign with the caller's nsec, no transformation.
     * - 'managed' (Phase F NIP-26 delegation): label rewrites event.pubkey, splices delegation tag.
     * - 'signed' (Phase G performer tag): label rewrites event.pubkey, splices performer tag.
     */
    async function signTrackEvent(unsigned, artistPubkey, callerPubkey) {
        const session = SessionManager.getSession();

        if (artistPubkey === callerPubkey) {
            return await session.sign({
                kind: unsigned.kind,
                pubkey: unsigned.pubkey,
                created_at: unsigned.created_at,
                tags: unsigned.tags,
                content: unsigned.content,
            });
        }

        const relationship = await fetchArtistRelationship(artistPubkey);
        const relType = relationship?.relationship_type || 'managed';

        if (relType === 'signed') {
            const tags = (unsigned.tags || []).slice();
            tags.push(['p', artistPubkey, '', 'performer']);
            return await session.sign({
                kind: unsigned.kind,
                pubkey: callerPubkey,
                created_at: unsigned.created_at,
                tags,
                content: unsigned.content,
            });
        }

        // Default: 'managed' — Phase F NIP-26 delegation
        let delegation;
        try {
            const resp = await SessionManager.authFetch(`/api/delegations/active/${artistPubkey}`);
            if (resp.status === 404) {
                throw new Error(`No active manager authorization from this artist.`);
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            delegation = await resp.json();
        } catch (e) {
            throw new Error(`Cannot publish on behalf of artist: ${e.message}`);
        }

        const tags = (unsigned.tags || []).slice();
        tags.push(['delegation', artistPubkey, delegation.conditions, delegation.signature]);

        return await session.sign({
            kind: unsigned.kind,
            pubkey: callerPubkey,
            created_at: unsigned.created_at,
            tags,
            content: unsigned.content,
        });
    }

    const _artistRelationshipCache = new Map();
    async function fetchArtistRelationship(pubkey) {
        if (_artistRelationshipCache.has(pubkey)) {
            return _artistRelationshipCache.get(pubkey);
        }
        try {
            const resp = await SessionManager.authFetch(`/api/label/artists/${pubkey}`);
            if (resp.ok) {
                const data = await resp.json();
                _artistRelationshipCache.set(pubkey, data);
                return data;
            }
        } catch (_) { /* fall through */ }
        const fallback = { relationship_type: 'managed' };
        _artistRelationshipCache.set(pubkey, fallback);
        return fallback;
    }

    // Delete all draft tracks in this release
    async function deleteDraft() {
        if (!confirm('Delete this draft? This cannot be undone.')) return;

        const deleteBtn = document.getElementById('delete-btn');
        deleteBtn.disabled = true;
        deleteBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div> Deleting...';

        try {
            let deletedCount = 0;
            for (const track of editingTracks) {
                const response = await SessionManager.authFetch(`/api/drafts/${track.id}`, {
                    method: 'DELETE'
                });
                if (response.ok) deletedCount++;
                else console.error(`Failed to delete track ${track.title}:`, await response.text());
            }

            if (deletedCount > 0) {
                showNotification('Draft deleted', 'success');
                setTimeout(() => AdminRouter.navigate('releases.html'), 1000);
            } else {
                throw new Error('Failed to delete any tracks');
            }
        } catch (error) {
            showNotification('Failed to delete: ' + error.message, 'error');
            deleteBtn.disabled = false;
            deleteBtn.innerHTML = '<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg> Delete';
        }
    }

    // NOTE (verbatim port): the original page declared publishToRelay twice —
    // this async/reject variant was shadowed by the resolve(false) variant
    // declared later in the script. Both are kept in the same order so hoisting
    // behaviour (the later declaration wins) is identical.
    // eslint-disable-next-line no-unused-vars
    async function publishToRelay_shadowed(signedEvent) {
        return new Promise((resolve, reject) => {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(`${protocol}//${location.host}/relay`);
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Relay publish timeout'));
            }, 10000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['EVENT', signedEvent]));
            };

            ws.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg[0] === 'OK') {
                    clearTimeout(timeout);
                    ws.close();
                    if (msg[2] === true) {
                        resolve(msg[1]); // event ID
                    } else {
                        reject(new Error(msg[3] || 'Relay rejected event'));
                    }
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                ws.close();
                reject(new Error('WebSocket error'));
            };
        });
    }

    // Delete a released track/album from NOSTR + clean up storage
    async function deleteRelease() {
        const session = SessionManager.getSession();
        if (!session) {
            showNotification('Not logged in', 'error');
            return;
        }

        const trackCount = editingTracks.length;
        const trackWord = trackCount === 1 ? 'track' : `${trackCount} tracks`;
        if (!confirm(`Permanently delete this release (${trackWord})?\n\nThis removes it from NOSTR, deletes audio files, and cannot be undone.`)) {
            return;
        }

        const deleteBtn = document.getElementById('delete-btn');
        deleteBtn.disabled = true;
        deleteBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div> Deleting...';

        try {
            // 1. Collect event IDs for Kind 5 deletion
            const eventIds = editingTracks
                .map(t => t.eventId)
                .filter(id => id);

            if (eventIds.length === 0) {
                throw new Error('No event IDs found for deletion');
            }

            // 2. Determine which Blossom hashes are safe to delete
            //    Check all artist tracks to see if any OTHER release shares the same hash
            const currentBlossomHashes = new Set(
                editingTracks.map(t => t.blossomAudioHash).filter(h => h)
            );
            const currentCoverHash = editingRelease.blossomCoverHash || '';
            const currentCoverCid = editingRelease.coverArtCid || '';
            const currentEventIds = new Set(eventIds);

            // Check all tracks on relay for shared references
            const otherTracks = allTracks.filter(t => !currentEventIds.has(t.eventId));
            const sharedAudioHashes = new Set();
            const sharedCoverHashes = new Set();
            const sharedCoverCids = new Set();

            otherTracks.forEach(t => {
                if (currentBlossomHashes.has(t.blossomAudioHash)) {
                    sharedAudioHashes.add(t.blossomAudioHash);
                }
                if (currentCoverHash && t.blossomCoverHash === currentCoverHash) {
                    sharedCoverHashes.add(t.blossomCoverHash);
                }
                if (currentCoverCid && t.coverArtCid === currentCoverCid) {
                    sharedCoverCids.add(t.coverArtCid);
                }
            });

            // 3. Sign Kind 5 deletion event
            const eTags = eventIds.map(id => ['e', id]);
            const signedEvent = await session.sign({
                kind: 5,
                pubkey: session.pubkey,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['app', 'Equaliser'], ...eTags],
                content: 'Release deleted by artist'
            });

            // 4. Publish Kind 5 to relay
            await publishToRelay(signedEvent);

            // 5. Build cleanup request — only include hashes that aren't shared
            const cleanupTracks = editingTracks.map(track => {
                const item = {
                    ipfs_manifest_cid: track.manifestCid,
                    ipfs_preview_cid: track.previewCid,
                };
                // Only include Blossom audio hash if no other release uses it
                if (track.blossomAudioHash && !sharedAudioHashes.has(track.blossomAudioHash)) {
                    item.blossom_audio_hash = track.blossomAudioHash;
                }
                return item;
            });

            // Add cover art cleanup to the first track item (only once)
            if (cleanupTracks.length > 0) {
                if (currentCoverCid && !sharedCoverCids.has(currentCoverCid)) {
                    cleanupTracks[0].cover_art_cid = currentCoverCid;
                }
                if (currentCoverHash && !sharedCoverHashes.has(currentCoverHash)) {
                    cleanupTracks[0].blossom_cover_hash = currentCoverHash;
                }
            }

            // 6. Call cleanup endpoint
            await SessionManager.authFetch('/api/tracks/cleanup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tracks: cleanupTracks })
            });

            showNotification('Release deleted successfully', 'success');
            setTimeout(() => AdminRouter.navigate('releases.html'), 1500);

        } catch (error) {
            showNotification('Failed to delete: ' + error.message, 'error');
            deleteBtn.disabled = false;
            deleteBtn.innerHTML = '<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg> Delete Release';
        }
    }

    // Save draft to database (without releasing)
    async function saveDraft() {
        const session = SessionManager.getSession();
        if (!session) {
            showNotification('Not logged in', 'error');
            return;
        }

        const newTitle = document.getElementById('release-title').value;
        const newArtist = document.getElementById('release-artist').value;
        const newType = document.getElementById('release-type').value;
        const newGenre = document.getElementById('release-genre').value;
        const newDate = document.getElementById('release-date').value;
        const newCoverCid = document.getElementById('cover-cid').value;
        const newBlossomCoverHash = document.getElementById('cover-blossom-hash').value;

        if (!newTitle || !newArtist) {
            showNotification('Title and artist are required', 'error');
            return;
        }

        const saveBtn = document.getElementById('save-btn');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div> Saving...';

        try {
            // Update ALL tracks in the release (not just the first one)
            let savedCount = 0;
            for (let i = 0; i < editingTracks.length; i++) {
                const track = editingTracks[i];
                // For singles, the release title IS the track title
                const trackTitle = (newType === 'single' && editingTracks.length === 1)
                    ? newTitle
                    : track.title;
                const updateData = {
                    title: trackTitle,
                    artist_name: newArtist,
                    album: newType !== 'single' ? newTitle : null,
                    release_type: newType,
                    genre: newGenre || null,
                    release_date: newDate || null,
                    cover_art_cid: newCoverCid || null,
                    price_amount: track.priceAmount,
                    price_currency: track.priceCurrency,
                    track_number: i + 1  // Update track order
                };
                if (newBlossomCoverHash) {
                    updateData.blossom_cover_hash = newBlossomCoverHash;
                }
                const response = await SessionManager.authFetch(`/api/drafts/${track.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updateData)
                });

                if (response.ok) {
                    savedCount++;
                } else {
                    console.error(`Failed to save track ${track.title}:`, await response.text());
                }
            }

            if (savedCount === editingTracks.length) {
                showNotification('All changes saved', 'success');
            } else if (savedCount > 0) {
                showNotification(`Saved ${savedCount}/${editingTracks.length} tracks`, 'success');
            } else {
                throw new Error('Failed to save any tracks');
            }

        } catch (error) {
            showNotification('Failed to save: ' + error.message, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Save Draft`;
        }
    }

    // Release draft to NOSTR
    async function releaseDraft() {
        const session = SessionManager.getSession();
        if (!session) {
            showNotification('Not logged in', 'error');
            return;
        }

        // Save changes first
        const newTitle = document.getElementById('release-title').value;
        const newArtist = document.getElementById('release-artist').value;

        if (!newTitle || !newArtist) {
            showNotification('Title and artist are required', 'error');
            return;
        }

        const releaseBtn = document.getElementById('release-btn');
        const saveBtn = document.getElementById('save-btn');
        releaseBtn.disabled = true;
        saveBtn.disabled = true;
        releaseBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div> Releasing...';

        try {
            // Save changes first
            await saveDraft();

            // Release ALL tracks in the release (not just the first one)
            let successCount = 0;
            const totalTracks = editingTracks.length;
            const releasedEventIds = [];

            for (const track of editingTracks) {
                try {
                    // Get unsigned event from API
                    const prepResponse = await SessionManager.authFetch(`/api/drafts/${track.id}/release`, {
                        method: 'POST'
                    });

                    if (!prepResponse.ok) {
                        const error = await prepResponse.json();
                        throw new Error(error.detail || 'Failed to prepare release');
                    }

                    const { unsigned_event, draft_id } = await prepResponse.json();

                    // Phase F/G sign router — handles self / managed (NIP-26) / signed (performer tag)
                    const signedEvent = await signTrackEvent(unsigned_event, unsigned_event.pubkey, session.publicKey);

                    // Publish to NOSTR (draft will be deleted from database)
                    const publishResponse = await SessionManager.authFetch('/api/tracks/publish', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            signed_event: signedEvent,
                            draft_id: draft_id
                        })
                    });

                    if (!publishResponse.ok) {
                        const error = await publishResponse.json();
                        throw new Error(error.detail || 'Failed to publish');
                    }

                    releasedEventIds.push(signedEvent.id);
                    successCount++;
                } catch (e) {
                    console.error(`Failed to release track ${track.title}:`, e);
                }
            }

            if (successCount === 0) {
                showNotification('Failed to release tracks', 'error');
                releaseBtn.disabled = false;
                saveBtn.disabled = false;
                releaseBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clip-rule="evenodd"/></svg> Release`;
                return;
            }

            if (successCount === totalTracks) {
                showNotification(`Released ${totalTracks === 1 ? 'track' : `all ${totalTracks} tracks`} successfully!`, 'success');
            } else {
                showNotification(`Released ${successCount}/${totalTracks} tracks`, 'success');
            }

            // Show announcement modal
            showAnnouncementModal(releasedEventIds, successCount);

        } catch (error) {
            showNotification('Failed to release: ' + error.message, 'error');
            releaseBtn.disabled = false;
            saveBtn.disabled = false;
            releaseBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clip-rule="evenodd"/></svg> Release`;
        }
    }

    // ===== Release Announcement =====

    let _announcementEventIds = [];

    function showAnnouncementModal(eventIds, trackCount) {
        _announcementEventIds = eventIds;
        const modal = document.getElementById('announce-modal');

        // Build default message
        const title = document.getElementById('release-title').value.trim();
        const isSingle = trackCount === 1;
        const defaultMsg = isSingle
            ? `Just released '${title}'! Listen now on Equaliser`
            : `Just released '${title}' \u2014 ${trackCount} tracks! Listen now on Equaliser`;

        document.getElementById('announce-message').value = defaultMsg;

        // Show cover art preview if available
        const coverPreview = document.getElementById('announce-cover-preview');
        const coverUrl = editingRelease?.blossomCoverUrl || (editingRelease?.blossomCoverHash ? `/blossom/${editingRelease.blossomCoverHash}` : (editingRelease?.coverArtCid ? `/ipfs/${editingRelease.coverArtCid}` : null));
        if (coverUrl && coverPreview) {
            coverPreview.innerHTML = `<img src="${coverUrl}" class="eq-announce-cover-img" style="max-width:200px;max-height:200px;" onerror="this.parentElement.style.display='none'">`;
        }

        modal.classList.add('active');
    }

    function skipAnnouncement() {
        document.getElementById('announce-modal').classList.remove('active');
        AdminRouter.navigate('releases.html');
    }

    async function postAnnouncement() {
        const btn = document.getElementById('announce-btn');
        const message = document.getElementById('announce-message').value.trim();
        if (!message) { skipAnnouncement(); return; }

        btn.disabled = true;
        btn.innerHTML = '<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;margin:0;display:inline-block;"></div> Posting...';

        try {
            const event = {
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['content-type', 'release-announcement'],
                    ..._announcementEventIds.map(id => ['e', id])
                ],
                content: message
            };

            const signedEvent = await SessionManager.signEvent(event);
            const ok = await publishToRelay(signedEvent);

            if (ok) {
                showNotification('Announcement posted!', 'success');
            } else {
                showNotification('Failed to post announcement', 'error');
            }
        } catch (err) {
            console.error('Announcement failed:', err);
            showNotification('Failed to post: ' + err.message, 'error');
        }

        setTimeout(() => { AdminRouter.navigate('releases.html'); }, 1000);
    }

    function publishToRelay(signedEvent) {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const relayUrl = `${wsProtocol}//${window.location.host}/relay`;
        return new Promise((resolve) => {
            const ws = new WebSocket(relayUrl);
            const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(false); }, 5000);
            ws.onopen = () => ws.send(JSON.stringify(['EVENT', signedEvent]));
            ws.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'OK') { clearTimeout(timeout); ws.close(); resolve(data[2] === true); }
                } catch(err) {}
            };
            ws.onerror = () => { clearTimeout(timeout); resolve(false); };
        });
    }

    // Utilities
    function formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
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

        const icon = notification.querySelector('.notification-icon');
        if (type === 'success') {
            icon.innerHTML = '<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>';
        } else {
            icon.innerHTML = '<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>';
        }

        notification.classList.add('show');
        setTimeout(() => notification.classList.remove('show'), 4000);
    }

    const EditReleasePage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Reset module state so a revisit starts clean
            allTracks = [];
            editingRelease = null;
            editingTracks = [];
            removedTracks = [];
            addedTracks = [];
            selectedTracksToAdd = [];
            activeTrackD = null;
            isDraftMode = false;
            draftData = null;
            _announcementEventIds = [];
            _artistRelationshipCache.clear();
            _pollTimers.forEach(t => clearInterval(t));
            _pollTimers.clear();

            // Expose functions referenced by inline on* handlers
            window.saveRelease = saveRelease;
            window.saveDraft = saveDraft;
            window.releaseDraft = releaseDraft;
            window.deleteDraft = deleteDraft;
            window.deleteRelease = deleteRelease;
            window.handleCoverUpload = handleCoverUpload;
            window.handleReleaseTypeChange = handleReleaseTypeChange;
            window.handleTrackUpload = handleTrackUpload;
            window.openAddTrackModal = openAddTrackModal;
            window.closeAddTrackModal = closeAddTrackModal;
            window.confirmAddTracks = confirmAddTracks;
            window.toggleTrackSelection = toggleTrackSelection;
            window.moveTrack = moveTrack;
            window.updateTrackField = updateTrackField;
            window.removeTrack = removeTrack;
            window.skipAnnouncement = skipAnnouncement;
            window.postAnnouncement = postAnnouncement;

            // Operators are infrastructure-only — redirect to their home (hard role
            // separation). Deferred a tick: the router ignores navigate() while a
            // navigation is in flight.
            if (SessionManager.getRole() === 'operator') {
                setTimeout(() => AdminRouter.navigate('node-overview.html'), 0);
                return;
            }

            // Click anywhere outside move buttons to deselect
            document.addEventListener('click', onDocumentClick);

            // Get parameters from URL
            const urlParams = new URLSearchParams(window.location.search);
            const releaseId = urlParams.get('id');
            isDraftMode = urlParams.get('draft') === 'true';

            if (!releaseId) {
                showError('No release ID provided');
                return;
            }

            if (isDraftMode) {
                // Load draft from API
                await loadDraft(releaseId);
            } else {
                // Load released track from NOSTR
                await loadAllTracks();
                loadRelease(releaseId);
            }
        },

        cleanup() {
            document.removeEventListener('click', onDocumentClick);
            _pollTimers.forEach(t => clearInterval(t));
            _pollTimers.clear();
            delete window.saveRelease;
            delete window.saveDraft;
            delete window.releaseDraft;
            delete window.deleteDraft;
            delete window.deleteRelease;
            delete window.handleCoverUpload;
            delete window.handleReleaseTypeChange;
            delete window.handleTrackUpload;
            delete window.openAddTrackModal;
            delete window.closeAddTrackModal;
            delete window.confirmAddTracks;
            delete window.toggleTrackSelection;
            delete window.moveTrack;
            delete window.updateTrackField;
            delete window.removeTrack;
            delete window.skipAnnouncement;
            delete window.postAnnouncement;
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['edit-release'] = EditReleasePage;
})();
