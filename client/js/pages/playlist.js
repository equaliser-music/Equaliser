/**
 * Playlist Detail Page Module
 *
 * Displays a single playlist with tracks, play/shuffle/edit/share/follow actions.
 * Works without login — non-authenticated users see public playlists with preview playback.
 */
(function() {
    'use strict';

    const PlaylistPage = {
        _playlist: null,
        _tracks: [],
        _profiles: new Map(),
        _isOwner: false,
        _isLoggedIn: false,
        _isFollowing: false,
        _isEditing: false,

        async init(params) {
            this._isLoggedIn = SessionManager.hasSession();

            // Parse query params
            const urlParams = new URLSearchParams(window.location.search);
            const pubkey = params?.pubkey || urlParams.get('pubkey');
            const dTag = params?.d || urlParams.get('d');

            if (!pubkey || !dTag) {
                this._renderNotFound();
                return;
            }

            try {
                this._playlist = await NostrPlaylists.fetchPlaylist(pubkey, dTag);
                if (!this._playlist) {
                    this._renderNotFound();
                    return;
                }

                // Owner detection
                const session = SessionManager.getSession();
                this._isOwner = session?.publicKey === this._playlist.pubkey;

                // Check if following (for non-owner logged-in users)
                if (this._isLoggedIn && !this._isOwner) {
                    const followed = await NostrPlaylists.fetchFollowedPlaylists();
                    this._isFollowing = followed.some(f =>
                        f.pubkey === this._playlist.pubkey && f.dTag === this._playlist.dTag
                    );
                }

                // Resolve tracks
                if (this._playlist.trackIds.length > 0) {
                    this._tracks = await NostrPlaylists.resolveTrackEvents(this._playlist.trackIds);
                }

                // Fetch creator profile
                const profiles = await NostrSocial.fetchProfiles([this._playlist.pubkey]);
                this._profiles = profiles;

                this._render();
                this._bindEvents();

                // Listen for player track changes to highlight current track
                window.addEventListener('eq-player-track-change', this._onTrackChange);
            } catch (err) {
                console.error('Failed to load playlist:', err);
                this._renderNotFound();
            }
        },

        cleanup() {
            window.removeEventListener('eq-player-track-change', this._onTrackChange);
            this._playlist = null;
            this._tracks = [];
            this._profiles = new Map();
        },

        // ===== Event Handlers =====

        _onTrackChange: function(e) {
            // Update playing state on track items
            document.querySelectorAll('.playlist-track-item').forEach(item => {
                const idx = parseInt(item.dataset.index);
                const track = e.detail.track;
                const plTrack = PlaylistPage._tracks[idx];
                const isPlaying = plTrack && track &&
                    ((plTrack.previewCid && plTrack.previewCid === track.previewCid) ||
                     (plTrack.manifestCid && plTrack.manifestCid === track.manifestCid));
                item.classList.toggle('playing', !!isPlaying);
            });
        },

        // ===== Rendering =====

        _renderNotFound() {
            const content = document.getElementById('playlist-content');
            if (content) {
                content.innerHTML = `
                    <div class="playlist-not-found">
                        <h3>Playlist not found</h3>
                        <p>This playlist may have been deleted or the link is invalid.</p>
                    </div>`;
            }
        },

        _render() {
            const content = document.getElementById('playlist-content');
            if (!content) return;

            const pl = this._playlist;
            const escapeHtml = NostrSocial.escapeHtml;
            const profile = this._profiles.get(pl.pubkey) || {};
            const creatorName = profile.name || 'Unknown';
            let creatorNpub = '';
            try { creatorNpub = window.NostrTools.nip19.npubEncode(pl.pubkey); } catch (e) {}

            const trackCount = this._tracks.length;
            const totalDuration = this._tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
            const durationStr = totalDuration > 0 ? ` · ${Math.floor(totalDuration / 60)} min` : '';
            const visLabel = pl.visibility === 'private' ? 'Private' : 'Public';

            // Cover mosaic
            const coverHtml = this._renderCoverMosaic();

            // Action buttons (auth-aware)
            let actionsHtml = '';
            if (this._tracks.length > 0) {
                actionsHtml += `<button class="playlist-btn playlist-btn-primary" id="pl-play-all">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg>
                    Play All</button>`;
                actionsHtml += `<button class="playlist-btn playlist-btn-secondary" id="pl-shuffle">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.757a.75.75 0 00-.75.75v3.475a.75.75 0 001.5 0v-1.27a7.002 7.002 0 0011.805-3.61.75.75 0 00-1.5 0zM4.688 8.576a5.5 5.5 0 019.201-2.466l.312.311h-2.433a.75.75 0 000 1.5h3.475a.75.75 0 00.75-.75V3.696a.75.75 0 00-1.5 0v1.27A7.002 7.002 0 002.688 8.576a.75.75 0 001.5 0z"/></svg>
                    Shuffle</button>`;
            }

            // Copy Link - available to everyone
            actionsHtml += `<button class="playlist-btn playlist-btn-secondary" id="pl-copy-link">
                <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z"/></svg>
                Copy Link</button>`;

            // Owner-only actions
            if (this._isOwner) {
                actionsHtml += `<button class="playlist-btn playlist-btn-secondary" id="pl-share">Share to Feed</button>`;
                actionsHtml += `<button class="playlist-btn playlist-btn-secondary" id="pl-edit">Edit</button>`;
                actionsHtml += `<button class="playlist-btn playlist-btn-danger" id="pl-delete">Delete</button>`;
            }

            // Follow button for logged-in non-owners on public playlists
            if (this._isLoggedIn && !this._isOwner && pl.visibility !== 'private') {
                if (this._isFollowing) {
                    actionsHtml += `<button class="playlist-btn playlist-btn-following" id="pl-follow">Following</button>`;
                } else {
                    actionsHtml += `<button class="playlist-btn playlist-btn-follow" id="pl-follow">Follow</button>`;
                }
            }

            content.innerHTML = `
                <div class="playlist-header">
                    <div class="playlist-cover">${coverHtml}</div>
                    <div class="playlist-info">
                        <h1 id="pl-title-display">${escapeHtml(pl.title)}</h1>
                        <div class="playlist-creator">
                            ${creatorNpub
                                ? `by <a href="/user.html?npub=${creatorNpub}">${escapeHtml(creatorName)}</a>`
                                : `by ${escapeHtml(creatorName)}`}
                        </div>
                        <div class="playlist-meta">${trackCount} track${trackCount !== 1 ? 's' : ''}${durationStr} · ${visLabel}</div>
                        ${pl.description ? `<div class="playlist-description" id="pl-desc-display">${escapeHtml(pl.description)}</div>` : ''}
                        <div class="playlist-actions">${actionsHtml}</div>
                    </div>
                </div>
                <div class="playlist-tracks" id="pl-track-list">
                    ${this._renderTrackList()}
                </div>`;
        },

        _renderCoverMosaic() {
            const covers = this._tracks
                .filter(t => t.blossomCoverUrl || t.blossomCoverHash || t.coverArtCid)
                .slice(0, 4);

            if (covers.length === 0) {
                return `<div class="cover-placeholder">
                    <svg fill="currentColor" viewBox="0 0 20 20"><path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/></svg>
                </div>`;
            }

            // Fill to 4 by repeating
            while (covers.length < 4) covers.push(covers[covers.length - 1]);

            return covers.slice(0, 4).map(t => {
                const url = t.blossomCoverUrl || (t.blossomCoverHash ? `/blossom/${t.blossomCoverHash}` : `/ipfs/${t.coverArtCid}`);
                return `<img src="${url}" alt="">`;
            }).join('');
        },

        _renderTrackList() {
            if (this._tracks.length === 0) {
                return '<div class="playlist-empty-tracks">No tracks in this playlist yet.</div>';
            }

            const escapeHtml = NostrSocial.escapeHtml;
            const playerState = EqualiserPlayer.getState();
            const currentTrack = playerState.track;

            return this._tracks.map((track, i) => {
                const coverUrl = track.blossomCoverUrl
                    || (track.blossomCoverHash ? `/blossom/${track.blossomCoverHash}` : '')
                    || (track.coverArtCid ? `/ipfs/${track.coverArtCid}` : '');

                const isPlaying = currentTrack &&
                    ((track.previewCid && track.previewCid === currentTrack.previewCid) ||
                     (track.manifestCid && track.manifestCid === currentTrack.manifestCid));

                let artistLink = escapeHtml(track.artist || 'Unknown Artist');
                if (track.pubkey) {
                    try {
                        const npub = window.NostrTools.nip19.npubEncode(track.pubkey);
                        artistLink = `<a href="/artist.html?npub=${npub}">${artistLink}</a>`;
                    } catch (e) {}
                }

                const durationStr = track.duration ? this._formatTime(track.duration) : '';

                return `
                    <div class="playlist-track-item${isPlaying ? ' playing' : ''}" data-index="${i}">
                        <div class="playlist-track-number">${i + 1}</div>
                        <div class="playlist-track-cover">
                            ${coverUrl ? `<img src="${coverUrl}" alt="">` : ''}
                        </div>
                        <div class="playlist-track-info">
                            <div class="playlist-track-title">${escapeHtml(track.title)}</div>
                            <div class="playlist-track-artist">${artistLink}</div>
                        </div>
                        <div class="playlist-track-duration">${durationStr}</div>
                        ${this._isOwner ? `<button class="playlist-track-remove" data-remove="${i}" title="Remove">&times;</button>` : ''}
                    </div>`;
            }).join('');
        },

        // ===== Event Binding =====

        _bindEvents() {
            // Play All
            const playBtn = document.getElementById('pl-play-all');
            if (playBtn) playBtn.addEventListener('click', () => this._playAll());

            // Shuffle
            const shuffleBtn = document.getElementById('pl-shuffle');
            if (shuffleBtn) shuffleBtn.addEventListener('click', () => this._shuffle());

            // Copy Link
            const copyBtn = document.getElementById('pl-copy-link');
            if (copyBtn) copyBtn.addEventListener('click', () => this._copyLink());

            // Share
            const shareBtn = document.getElementById('pl-share');
            if (shareBtn) shareBtn.addEventListener('click', () => this._showShareModal());

            // Edit
            const editBtn = document.getElementById('pl-edit');
            if (editBtn) editBtn.addEventListener('click', () => this._toggleEdit());

            // Delete
            const deleteBtn = document.getElementById('pl-delete');
            if (deleteBtn) deleteBtn.addEventListener('click', () => this._handleDelete());

            // Follow/Unfollow
            const followBtn = document.getElementById('pl-follow');
            if (followBtn) followBtn.addEventListener('click', () => this._toggleFollow());

            // Share modal submit
            const shareSubmit = document.getElementById('share-submit');
            if (shareSubmit) shareSubmit.addEventListener('click', () => this._handleShare());

            // Track clicks
            const trackList = document.getElementById('pl-track-list');
            if (trackList) {
                trackList.addEventListener('click', (e) => {
                    // Remove button
                    const removeBtn = e.target.closest('.playlist-track-remove');
                    if (removeBtn) {
                        e.stopPropagation();
                        this._removeTrack(parseInt(removeBtn.dataset.remove, 10));
                        return;
                    }
                    // Track click - play from this position
                    const item = e.target.closest('.playlist-track-item');
                    if (item && !e.target.closest('a')) {
                        const idx = parseInt(item.dataset.index, 10);
                        this._playFromIndex(idx);
                    }
                });
            }
        },

        // ===== Actions =====

        _playAll() {
            if (this._tracks.length === 0) return;
            const playerTracks = this._tracks.map(t => ({
                title: t.title,
                artist: t.artist || 'Unknown Artist',
                previewCid: t.previewCid,
                manifestCid: t.manifestCid,
                blossomCoverUrl: t.blossomCoverUrl,
                blossomCoverHash: t.blossomCoverHash,
                coverArtCid: t.coverArtCid,
                duration: t.duration
            }));
            EqualiserPlayer.setPlaylist(playerTracks, 0);
        },

        _shuffle() {
            if (this._tracks.length === 0) return;
            const shuffled = [...this._tracks].sort(() => Math.random() - 0.5);
            const playerTracks = shuffled.map(t => ({
                title: t.title,
                artist: t.artist || 'Unknown Artist',
                previewCid: t.previewCid,
                manifestCid: t.manifestCid,
                blossomCoverUrl: t.blossomCoverUrl,
                blossomCoverHash: t.blossomCoverHash,
                coverArtCid: t.coverArtCid,
                duration: t.duration
            }));
            EqualiserPlayer.setPlaylist(playerTracks, 0);
        },

        _playFromIndex(index) {
            if (index < 0 || index >= this._tracks.length) return;
            const playerTracks = this._tracks.map(t => ({
                title: t.title,
                artist: t.artist || 'Unknown Artist',
                previewCid: t.previewCid,
                manifestCid: t.manifestCid,
                blossomCoverUrl: t.blossomCoverUrl,
                blossomCoverHash: t.blossomCoverHash,
                coverArtCid: t.coverArtCid,
                duration: t.duration
            }));
            EqualiserPlayer.setPlaylist(playerTracks, index);
        },

        _copyLink() {
            const pl = this._playlist;
            const url = `${window.location.origin}/playlist.html?pubkey=${pl.pubkey}&d=${pl.dTag}`;
            navigator.clipboard.writeText(url).then(() => this._showToast('Link copied!'));
        },

        // ===== Edit =====

        _toggleEdit() {
            this._isEditing = !this._isEditing;
            if (this._isEditing) {
                this._showEditUI();
            } else {
                this._render();
                this._bindEvents();
            }
        },

        _showEditUI() {
            const pl = this._playlist;
            const titleEl = document.getElementById('pl-title-display');
            const descEl = document.getElementById('pl-desc-display');
            const editBtn = document.getElementById('pl-edit');

            if (titleEl) {
                titleEl.outerHTML = `<input type="text" class="playlist-edit-field" id="pl-title-edit" value="${NostrSocial.escapeHtml(pl.title)}" maxlength="100">`;
            }

            if (descEl) {
                descEl.outerHTML = `<textarea class="playlist-edit-field" id="pl-desc-edit" maxlength="500" rows="2">${NostrSocial.escapeHtml(pl.description)}</textarea>`;
            } else {
                // Insert description textarea after the meta
                const metaEl = document.querySelector('.playlist-meta');
                if (metaEl) {
                    metaEl.insertAdjacentHTML('afterend', `<textarea class="playlist-edit-field" id="pl-desc-edit" placeholder="Add a description..." maxlength="500" rows="2"></textarea>`);
                }
            }

            if (editBtn) {
                editBtn.textContent = 'Save';
                editBtn.onclick = () => this._saveEdit();
            }

            // Add visibility toggle
            const actionsEl = document.querySelector('.playlist-actions');
            if (actionsEl) {
                const visToggle = document.createElement('button');
                visToggle.className = 'playlist-btn playlist-btn-secondary';
                visToggle.id = 'pl-vis-toggle';
                visToggle.textContent = pl.visibility === 'private' ? 'Make Public' : 'Make Private';
                visToggle.addEventListener('click', () => this._toggleVisibility());
                actionsEl.appendChild(visToggle);
            }
        },

        async _saveEdit() {
            const titleInput = document.getElementById('pl-title-edit');
            const descInput = document.getElementById('pl-desc-edit');
            const title = titleInput?.value.trim() || this._playlist.title;
            const description = descInput?.value.trim() || '';

            try {
                await NostrPlaylists.updatePlaylist(
                    this._playlist.dTag,
                    title,
                    this._playlist.trackIds,
                    {
                        description,
                        visibility: this._playlist.visibility,
                        image: this._playlist.image
                    }
                );

                this._playlist.title = title;
                this._playlist.description = description;
                NostrPlaylists.invalidateCache();
                this._isEditing = false;
                this._render();
                this._bindEvents();
                this._showToast('Playlist saved');
            } catch (err) {
                console.error('Failed to save playlist:', err);
                this._showToast('Failed to save');
            }
        },

        async _toggleVisibility() {
            const newVis = this._playlist.visibility === 'private' ? 'public' : 'private';

            try {
                await NostrPlaylists.updatePlaylist(
                    this._playlist.dTag,
                    this._playlist.title,
                    this._playlist.trackIds,
                    {
                        description: this._playlist.description,
                        visibility: newVis,
                        image: this._playlist.image
                    }
                );

                this._playlist.visibility = newVis;
                NostrPlaylists.invalidateCache();
                this._isEditing = false;
                this._render();
                this._bindEvents();
                this._showToast(`Playlist is now ${newVis}`);
            } catch (err) {
                console.error('Failed to toggle visibility:', err);
                this._showToast('Failed to update visibility');
            }
        },

        // ===== Delete =====

        async _handleDelete() {
            if (!confirm('Delete this playlist? This cannot be undone.')) return;

            try {
                await NostrPlaylists.deletePlaylist(this._playlist.dTag);
                NostrPlaylists.invalidateCache();
                Router.navigate('/library.html');
            } catch (err) {
                console.error('Failed to delete playlist:', err);
                this._showToast('Failed to delete');
            }
        },

        // ===== Remove Track =====

        async _removeTrack(index) {
            if (index < 0 || index >= this._playlist.trackIds.length) return;

            this._playlist.trackIds.splice(index, 1);
            this._tracks.splice(index, 1);

            try {
                await NostrPlaylists.updatePlaylist(
                    this._playlist.dTag,
                    this._playlist.title,
                    this._playlist.trackIds,
                    {
                        description: this._playlist.description,
                        visibility: this._playlist.visibility,
                        image: this._playlist.image
                    }
                );

                NostrPlaylists.invalidateCache();
                this._render();
                this._bindEvents();
            } catch (err) {
                console.error('Failed to remove track:', err);
                this._showToast('Failed to remove track');
            }
        },

        // ===== Follow =====

        async _toggleFollow() {
            const btn = document.getElementById('pl-follow');
            if (!btn) return;

            try {
                if (this._isFollowing) {
                    await NostrPlaylists.unfollowPlaylist(this._playlist.pubkey, this._playlist.dTag);
                    this._isFollowing = false;
                    btn.className = 'playlist-btn playlist-btn-follow';
                    btn.textContent = 'Follow';
                    this._showToast('Unfollowed playlist');
                } else {
                    await NostrPlaylists.followPlaylist(this._playlist.pubkey, this._playlist.dTag);
                    this._isFollowing = true;
                    btn.className = 'playlist-btn playlist-btn-following';
                    btn.textContent = 'Following';
                    this._showToast('Following playlist');
                }
            } catch (err) {
                console.error('Follow/unfollow failed:', err);
                this._showToast('Failed to update');
            }
        },

        // ===== Share =====

        _showShareModal() {
            const pl = this._playlist;
            let npub = '';
            try { npub = window.NostrTools.nip19.npubEncode(pl.pubkey); } catch (e) {}

            const defaultMsg = `Check out my playlist "${pl.title}" - ${pl.trackIds.length} track${pl.trackIds.length !== 1 ? 's' : ''}\n\nequaliser:playlist:${npub}/${pl.dTag}`;

            const textarea = document.getElementById('share-message');
            if (textarea) textarea.value = defaultMsg;

            const modal = document.getElementById('share-modal');
            if (modal) modal.classList.add('open');
        },

        async _handleShare() {
            const textarea = document.getElementById('share-message');
            const message = textarea?.value.trim();
            if (!message) return;

            const submitBtn = document.getElementById('share-submit');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting...'; }

            try {
                await NostrPlaylists.sharePlaylistToFeed(this._playlist, message);
                const modal = document.getElementById('share-modal');
                if (modal) modal.classList.remove('open');
                this._showToast('Posted to feed');
            } catch (err) {
                console.error('Failed to share:', err);
                this._showToast('Failed to post');
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Post to Feed'; }
            }
        },

        // ===== Utility =====

        _formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        _showToast(message) {
            const existing = document.querySelector('.eq-toast');
            if (existing) existing.remove();
            const toast = document.createElement('div');
            toast.className = 'eq-toast';
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
        }
    };

    // Register with the page module system
    if (!window.EqualiserPages) window.EqualiserPages = {};
    window.EqualiserPages.playlist = PlaylistPage;
})();
