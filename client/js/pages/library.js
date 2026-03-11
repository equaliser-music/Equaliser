/**
 * Library Page Module
 *
 * Displays user's playlists and followed playlists in a grid.
 * Supports creating new playlists and navigating to playlist detail pages.
 */
(function() {
    'use strict';

    const LibraryPage = {
        _activeTab: 'my',
        _myPlaylists: [],
        _followedPlaylists: [],
        _resolvedTracks: new Map(),

        init(params) {
            const isLoggedIn = SessionManager.hasSession();

            // Tab clicks
            document.querySelectorAll('#library-tabs .library-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    if (!isLoggedIn) return;
                    document.querySelectorAll('.library-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    this._activeTab = tab.dataset.tab;
                    this._renderContent();
                });
            });

            // Create button
            const createBtn = document.getElementById('library-create-btn');
            if (createBtn) {
                createBtn.addEventListener('click', () => this._showCreateModal());
            }

            // Modal events
            const cancelBtn = document.getElementById('create-cancel');
            if (cancelBtn) cancelBtn.addEventListener('click', () => this._hideCreateModal());

            const submitBtn = document.getElementById('create-submit');
            if (submitBtn) submitBtn.addEventListener('click', () => this._handleCreate());

            const titleInput = document.getElementById('create-title');
            if (titleInput) {
                titleInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') this._handleCreate();
                });
            }

            // Modal backdrop click
            const modal = document.getElementById('create-modal');
            if (modal) {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) this._hideCreateModal();
                });
            }

            if (!isLoggedIn) {
                // Hide create button and toolbar for non-logged-in users
                const toolbar = document.getElementById('library-toolbar');
                if (toolbar) toolbar.style.display = 'none';
                const content = document.getElementById('library-content');
                if (content) {
                    content.innerHTML = `
                        <div class="library-login-prompt">
                            <h3>Log in to manage playlists</h3>
                            <p><a href="/login.html">Log in</a> to create, edit and manage your playlists.</p>
                        </div>`;
                }
                return;
            }

            this._loadPlaylists();
        },

        cleanup() {
            this._myPlaylists = [];
            this._followedPlaylists = [];
            this._resolvedTracks = new Map();
        },

        // ===== Data Loading =====

        async _loadPlaylists() {
            try {
                this._myPlaylists = await NostrPlaylists.fetchMyPlaylists();
                this._renderContent();

                // Pre-fetch followed playlists in background
                this._loadFollowed();

                // Resolve cover art for first 4 tracks per playlist
                this._resolveCovers();
            } catch (err) {
                console.error('Failed to load playlists:', err);
                const content = document.getElementById('library-content');
                if (content) {
                    content.innerHTML = '<div class="library-empty"><p>Failed to load playlists.</p></div>';
                }
            }
        },

        async _loadFollowed() {
            try {
                const refs = await NostrPlaylists.fetchFollowedPlaylists();
                const results = await Promise.all(
                    refs.map(ref => NostrPlaylists.fetchPlaylist(ref.pubkey, ref.dTag))
                );
                this._followedPlaylists = results.filter(Boolean);
                if (this._activeTab === 'following') this._renderContent();
            } catch (err) {
                console.error('Failed to load followed playlists:', err);
            }
        },

        async _resolveCovers() {
            const allPlaylists = [...this._myPlaylists, ...this._followedPlaylists];
            const trackIdsNeeded = new Set();

            for (const pl of allPlaylists) {
                const coverIds = pl.trackIds.slice(0, 4);
                coverIds.forEach(id => {
                    if (!this._resolvedTracks.has(id)) trackIdsNeeded.add(id);
                });
            }

            if (trackIdsNeeded.size === 0) return;

            const tracks = await NostrPlaylists.resolveTrackEvents([...trackIdsNeeded]);
            for (const t of tracks) {
                this._resolvedTracks.set(t.eventId, t);
            }

            // Re-render to update covers
            this._renderContent();
        },

        // ===== Rendering =====

        _renderContent() {
            const content = document.getElementById('library-content');
            if (!content) return;

            const playlists = this._activeTab === 'my' ? this._myPlaylists : this._followedPlaylists;

            if (playlists.length === 0) {
                const isFollowing = this._activeTab === 'following';
                content.innerHTML = `
                    <div class="library-empty">
                        <h3>${isFollowing ? 'No followed playlists' : 'No playlists yet'}</h3>
                        <p>${isFollowing
                            ? 'Follow playlists from other users to see them here.'
                            : 'Create your first playlist to get started.'
                        }</p>
                    </div>`;
                return;
            }

            content.innerHTML = `<div class="playlist-grid">${playlists.map(pl => this._renderCard(pl)).join('')}</div>`;

            // Card click handlers
            content.querySelectorAll('.playlist-card').forEach(card => {
                const pubkey = card.dataset.pubkey;
                const dTag = card.dataset.dtag;

                card.addEventListener('click', (e) => {
                    // Don't navigate if clicking the link button
                    if (e.target.closest('.playlist-card-link')) return;
                    Router.navigate(`/playlist.html?pubkey=${pubkey}&d=${dTag}`);
                });
            });

            // Copy link button handlers
            content.querySelectorAll('.playlist-card-link').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const pubkey = btn.dataset.pubkey;
                    const dTag = btn.dataset.dtag;
                    const url = `${window.location.origin}/playlist.html?pubkey=${pubkey}&d=${dTag}`;
                    navigator.clipboard.writeText(url).then(() => this._showToast('Link copied!'));
                });
            });
        },

        _renderCard(playlist) {
            const escapeHtml = NostrSocial.escapeHtml;
            const trackCount = playlist.trackIds.length;
            const visLabel = playlist.visibility === 'private' ? 'Private' : 'Public';
            const coverHtml = this._renderCoverMosaic(playlist.trackIds.slice(0, 4));

            return `
                <div class="playlist-card" data-pubkey="${playlist.pubkey}" data-dtag="${playlist.dTag}">
                    <div class="playlist-card-cover">${coverHtml}</div>
                    <div class="playlist-card-info">
                        <div class="playlist-card-title">${escapeHtml(playlist.title)}</div>
                        <div class="playlist-card-meta">
                            <span>${trackCount} track${trackCount !== 1 ? 's' : ''} · ${visLabel}</span>
                            <button class="playlist-card-link" data-pubkey="${playlist.pubkey}" data-dtag="${playlist.dTag}" title="Copy link">
                                <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z"/></svg>
                            </button>
                        </div>
                    </div>
                </div>`;
        },

        _renderCoverMosaic(trackIds) {
            const covers = trackIds
                .map(id => this._resolvedTracks.get(id))
                .filter(t => t && (t.blossomCoverHash || t.coverArtCid));

            if (covers.length === 0) {
                return `<div class="cover-placeholder">
                    <svg fill="currentColor" viewBox="0 0 20 20"><path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/></svg>
                </div>`;
            }

            // Fill up to 4 slots by repeating
            while (covers.length < 4 && covers.length > 0) {
                covers.push(covers[covers.length - 1]);
            }

            return covers.slice(0, 4).map(t => {
                const url = t.blossomCoverUrl || (t.blossomCoverHash ? `/blossom/${t.blossomCoverHash}` : `/ipfs/${t.coverArtCid}`);
                return `<img src="${url}" alt="">`;
            }).join('');
        },

        // ===== Create Playlist =====

        _showCreateModal() {
            const modal = document.getElementById('create-modal');
            if (modal) {
                modal.classList.add('open');
                const input = document.getElementById('create-title');
                if (input) { input.value = ''; input.focus(); }
                const desc = document.getElementById('create-desc');
                if (desc) desc.value = '';
            }
        },

        _hideCreateModal() {
            const modal = document.getElementById('create-modal');
            if (modal) modal.classList.remove('open');
        },

        async _handleCreate() {
            const titleInput = document.getElementById('create-title');
            const descInput = document.getElementById('create-desc');
            const title = titleInput?.value.trim();
            if (!title) return;

            const description = descInput?.value.trim() || '';
            const visibility = document.querySelector('input[name="create-visibility"]:checked')?.value || 'public';

            const submitBtn = document.getElementById('create-submit');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating...'; }

            try {
                const { dTag } = await NostrPlaylists.createPlaylist(title, [], { description, visibility });
                NostrPlaylists.invalidateCache();
                this._hideCreateModal();
                const session = SessionManager.getSession();
                Router.navigate(`/playlist.html?pubkey=${session.publicKey}&d=${dTag}`);
            } catch (err) {
                console.error('Failed to create playlist:', err);
                alert('Failed to create playlist: ' + err.message);
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create'; }
            }
        },

        // ===== Utility =====

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
    window.EqualiserPages.library = LibraryPage;
})();
