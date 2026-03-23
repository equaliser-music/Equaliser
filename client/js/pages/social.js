/**
 * Social Page Module
 *
 * Feed (Timeline) + Community Threads with tabs.
 * Extracted from social.html for use with the app shell router.
 */
(function() {
    'use strict';

    const SocialPage = {
        // Feed state
        _activeTopTab: 'feed',
        _feedNotes: [],
        _feedReactionData: { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() },
        _currentFeedTab: 'equaliser',
        _feedProfiles: new Map(),
        _isPosting: false,
        _attachedImageUrl: null,

        // Community state
        _currentBoard: 'all',
        _threads: [],
        _threadProfiles: new Map(),
        _threadReplyCounts: new Map(),
        _activeThreadId: null,
        _activeThreadEvent: null,
        _activeThreadReplies: [],
        _activeThreadProfiles: new Map(),
        _isSubmitting: false,
        _communityLoaded: false,

        init(params) {
            const escapeHtml = NostrSocial.escapeHtml;

            // Expose global functions for onclick handlers
            window.switchTopTab = (tab) => this._switchTopTab(tab);
            window.switchFeedTab = (tab) => this._switchFeedTab(tab);
            window.switchBoard = (board) => this._switchBoard(board);
            window.toggleNewThreadForm = () => this._toggleNewThreadForm();
            window.submitThread = () => this._submitThread();
            window.openThread = (id) => this._openThread(id);
            window.showCommunityListView = () => this._showCommunityListView();
            window.submitThreadReply = () => this._submitThreadReply();
            window.navigateToThread = (id) => this._navigateToThread(id);
            window.handleFeedLike = (noteId, pubkey) => this._handleFeedLike(noteId, pubkey);
            window.handleFeedRepost = (noteId, pubkey) => this._handleFeedRepost(noteId, pubkey);
            window.expandPlaylistCard = (cardId) => this._expandPlaylistCard(cardId);
            window.playFromPlaylistCard = (cardId, index) => this._playFromPlaylistCard(cardId, index);

            // Set default feed tab
            this._currentFeedTab = SessionManager.hasSession() ? 'following' : 'equaliser';

            // Init composer
            this._initComposer();
            this._setupComposerEvents();

            // Render feed sub-tabs
            const feedSubTabsEl = document.getElementById('feed-sub-tabs');
            if (feedSubTabsEl) {
                if (SessionManager.hasSession()) {
                    feedSubTabsEl.innerHTML = `
                        <button class="feed-sub-tab active" data-tab="following" onclick="switchFeedTab('following')">Your Feed</button>
                        <button class="feed-sub-tab" data-tab="equaliser" onclick="switchFeedTab('equaliser')">Global Feed</button>`;
                } else {
                    feedSubTabsEl.innerHTML = `
                        <button class="feed-sub-tab active" data-tab="equaliser">Global Feed</button>`;
                }
            }

            // Show community toolbar if logged in
            if (SessionManager.hasSession()) {
                const toolbar = document.getElementById('community-toolbar');
                if (toolbar) toolbar.style.display = '';
            }

            // Wire up thread form validation
            this._wireThreadFormValidation();

            // Check URL params for initial state
            const tabParam = params.tab || null;
            const boardParam = params.board || null;
            const threadParam = params.thread || null;

            if (tabParam === 'community') {
                this._activeTopTab = 'community';
                document.querySelectorAll('.social-top-tab').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tab === 'community');
                });
                const feedSection = document.getElementById('feed-section');
                const communitySection = document.getElementById('community-section');
                if (feedSection) feedSection.classList.add('hidden');
                if (communitySection) communitySection.classList.add('visible');

                if (boardParam) {
                    this._currentBoard = boardParam;
                    document.querySelectorAll('.board-tab').forEach(btn => {
                        btn.classList.toggle('active', btn.dataset.board === boardParam);
                    });
                }

                if (threadParam) {
                    this._communityLoaded = true;
                    this._openThread(threadParam);
                } else {
                    this._communityLoaded = true;
                    this._loadThreads();
                }
            }

            // Always load feed (it's the default tab)
            this._loadFeed().catch(err => {
                console.error('Failed to load feed:', err);
                const feedEl = document.getElementById('feed-list');
                if (feedEl) {
                    feedEl.innerHTML = `
                        <div class="empty-area">
                            <p>Could not load feed</p>
                            <p class="sub"><a href="#" onclick="loadFeed(); return false;">Retry</a></p>
                        </div>`;
                }
            });
        },

        cleanup() {
            delete window.switchTopTab;
            delete window.switchFeedTab;
            delete window.switchBoard;
            delete window.toggleNewThreadForm;
            delete window.submitThread;
            delete window.openThread;
            delete window.showCommunityListView;
            delete window.submitThreadReply;
            delete window.navigateToThread;
            delete window.handleFeedLike;
            delete window.handleFeedRepost;
            delete window.expandPlaylistCard;
            delete window.playFromPlaylistCard;

            this._feedNotes = [];
            this._feedReactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
            this._feedProfiles = new Map();
            this._attachedImageUrl = null;
            this._threads = [];
            this._threadProfiles = new Map();
            this._threadReplyCounts = new Map();
            this._activeThreadId = null;
            this._activeThreadEvent = null;
            this._activeThreadReplies = [];
            this._activeThreadProfiles = new Map();
            this._communityLoaded = false;
            this._isPosting = false;
            this._isSubmitting = false;
            this._activeTopTab = 'feed';
            this._currentFeedTab = 'equaliser';
            this._currentBoard = 'all';
        },

        // ===== Top Tab Switching =====

        _switchTopTab(tab) {
            if (tab === this._activeTopTab) return;
            this._activeTopTab = tab;

            document.querySelectorAll('.social-top-tab').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tab);
            });

            const feedSection = document.getElementById('feed-section');
            const communitySection = document.getElementById('community-section');

            if (tab === 'feed') {
                if (feedSection) feedSection.classList.remove('hidden');
                if (communitySection) communitySection.classList.remove('visible');
            } else {
                if (feedSection) feedSection.classList.add('hidden');
                if (communitySection) communitySection.classList.add('visible');
                if (!this._communityLoaded) {
                    this._loadThreads();
                    this._communityLoaded = true;
                }
            }

            // Update URL with replaceState (avoid conflicts with router's popstate)
            const url = new URL(window.location);
            if (tab === 'feed') {
                url.searchParams.delete('tab');
                url.searchParams.delete('board');
                url.searchParams.delete('thread');
            } else {
                url.searchParams.set('tab', 'community');
            }
            history.replaceState({}, '', url);
        },

        // ===== Composer =====

        _initComposer() {
            const escapeHtml = NostrSocial.escapeHtml;
            const session = SessionManager.getSession();
            if (session) {
                const composerEl = document.getElementById('composer');
                const guestEl = document.getElementById('composer-guest');
                if (composerEl) composerEl.style.display = 'block';
                if (guestEl) guestEl.style.display = 'none';

                NostrSocial.fetchProfiles([session.publicKey]).then(profiles => {
                    const p = profiles.get(session.publicKey);
                    if (p && p.picture) {
                        const el = document.getElementById('composer-avatar');
                        if (el) el.innerHTML = `<img src="${escapeHtml(p.picture)}" alt="" onerror="this.style.display='none'">`;
                    } else if (p && p.name) {
                        const initials = p.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
                        const el = document.getElementById('composer-avatar');
                        if (el) el.textContent = initials;
                    }
                });
            } else {
                const composerEl = document.getElementById('composer');
                const guestEl = document.getElementById('composer-guest');
                if (composerEl) composerEl.style.display = 'none';
                if (guestEl) guestEl.style.display = 'block';
            }
        },

        _setupComposerEvents() {
            const textarea = document.getElementById('compose-text');
            const charCount = document.getElementById('char-count');
            const postBtn = document.getElementById('post-btn');
            if (!textarea || !charCount || !postBtn) return;

            textarea.addEventListener('input', () => {
                const len = textarea.value.length;
                charCount.textContent = `${len} / 1000`;
                charCount.className = 'char-count' + (len > 900 ? (len > 1000 ? ' over' : ' warn') : '');
                postBtn.disabled = (len === 0 && !this._attachedImageUrl) || len > 1000 || this._isPosting;
            });

            postBtn.addEventListener('click', () => this._submitPost());

            textarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (!postBtn.disabled) this._submitPost();
                }
            });

            // Image attach button
            const attachBtn = document.getElementById('composer-attach-btn');
            const imageInput = document.getElementById('composer-image-input');
            if (attachBtn && imageInput) {
                attachBtn.addEventListener('click', () => imageInput.click());
                imageInput.addEventListener('change', (e) => this._handleImageAttach(e));
            }
        },

        async _handleImageAttach(event) {
            const file = event.target.files[0];
            if (!file) return;

            const previewEl = document.getElementById('composer-image-preview');
            const statusEl = document.getElementById('composer-upload-status');
            const postBtn = document.getElementById('post-btn');

            // Show local preview immediately
            const localUrl = URL.createObjectURL(file);
            if (previewEl) {
                previewEl.style.display = 'block';
                previewEl.innerHTML = `<img src="${localUrl}" alt=""><button class="composer-image-remove" onclick="event.preventDefault(); EqualiserPages.social._removeAttachedImage()">&times;</button>`;
            }
            if (statusEl) { statusEl.textContent = 'Uploading...'; statusEl.className = 'composer-upload-status uploading'; }

            try {
                const formData = new FormData();
                formData.append('file', file);
                const response = await fetch('/api/upload/image', { method: 'POST', body: formData });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.detail || `Upload failed: ${response.status}`);
                }
                const result = await response.json();
                this._attachedImageUrl = result.blossom_url;
                URL.revokeObjectURL(localUrl);

                if (previewEl) {
                    previewEl.innerHTML = `<img src="${this._attachedImageUrl}" alt=""><button class="composer-image-remove" onclick="event.preventDefault(); EqualiserPages.social._removeAttachedImage()">&times;</button>`;
                }
                if (statusEl) { statusEl.textContent = ''; statusEl.className = 'composer-upload-status'; }

                // Enable post button if image attached (even with empty text)
                if (postBtn) postBtn.disabled = false;
            } catch (error) {
                console.error('Image upload error:', error);
                if (statusEl) { statusEl.textContent = 'Upload failed: ' + error.message; statusEl.className = 'composer-upload-status error'; }
                this._removeAttachedImage();
            }

            // Reset file input so same file can be re-selected
            event.target.value = '';
        },

        _removeAttachedImage() {
            this._attachedImageUrl = null;
            const previewEl = document.getElementById('composer-image-preview');
            const statusEl = document.getElementById('composer-upload-status');
            const postBtn = document.getElementById('post-btn');
            const textarea = document.getElementById('compose-text');
            if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'composer-upload-status'; }
            if (postBtn && textarea) postBtn.disabled = textarea.value.trim().length === 0;
        },

        async _submitPost() {
            const textarea = document.getElementById('compose-text');
            const postBtn = document.getElementById('post-btn');
            let content = textarea.value.trim();

            // Append image URL if attached
            if (this._attachedImageUrl) {
                content = content ? content + '\n' + this._attachedImageUrl : this._attachedImageUrl;
            }

            if (!content || this._isPosting) return;

            const session = SessionManager.getSession();
            if (!session) return;

            this._isPosting = true;
            if (postBtn) { postBtn.disabled = true; postBtn.textContent = 'Posting...'; }

            try {
                const event = {
                    kind: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['content-type', 'post']],
                    content: content
                };

                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                textarea.value = '';
                this._removeAttachedImage();
                const charCount = document.getElementById('char-count');
                if (charCount) { charCount.textContent = '0 / 1000'; charCount.className = 'char-count'; }

                const successEl = document.getElementById('post-success');
                if (successEl) { successEl.classList.add('show'); setTimeout(() => successEl.classList.remove('show'), 2000); }

                this._feedNotes.unshift(signedEvent);

                if (!this._feedProfiles.has(signedEvent.pubkey)) {
                    const profiles = await NostrSocial.fetchProfiles([signedEvent.pubkey]);
                    profiles.forEach((v, k) => this._feedProfiles.set(k, v));
                }

                this._renderFeed();
            } catch (error) {
                console.error('Post failed:', error);
                alert('Failed to post. Please try again.');
            } finally {
                this._isPosting = false;
                if (postBtn) { postBtn.disabled = textarea.value.trim().length === 0; postBtn.textContent = 'Post'; }
            }
        },

        // ===== Feed Loading =====

        async _loadFeed(tab) {
            tab = tab || this._currentFeedTab;
            const feedEl = document.getElementById('feed-list');
            if (!feedEl) return;

            feedEl.innerHTML = `<div class="loading-area"><div class="loading-spinner"></div><div>Loading feed...</div></div>`;

            let filter;
            let emptyMessage;

            if (tab === 'equaliser') {
                filter = { kinds: [1], limit: 50 };
                emptyMessage = `<p>No posts yet</p><p class="sub">Community posts will appear here</p>`;
            } else {
                const followedPubkeys = await NostrSocial.fetchContactList();
                const session = SessionManager.getSession();
                const feedAuthors = session ? [session.publicKey, ...followedPubkeys] : [...followedPubkeys];
                if (feedAuthors.length > 0) {
                    filter = { kinds: [1], authors: feedAuthors, limit: 50 };
                    emptyMessage = `<p>No posts yet</p><p class="sub">Follow some artists to see their posts here</p>`;
                } else {
                    feedEl.innerHTML = `
                        <div class="empty-area">
                            <svg fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                            </svg>
                            <p>Your feed is empty</p>
                            <p class="sub">Follow some artists to see their posts here</p>
                        </div>`;
                    this._feedNotes = [];
                    return;
                }
            }

            let allNotes = await NostrSocial.fetchNotes(filter);
            allNotes = allNotes.filter(n => NostrSocial.isTopLevelPost(n));

            if (allNotes.length === 0) {
                feedEl.innerHTML = `
                    <div class="empty-area">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                        </svg>
                        ${emptyMessage}
                    </div>`;
                this._feedNotes = [];
                return;
            }

            this._feedNotes = allNotes;

            const authorPubkeys = [...new Set(allNotes.map(n => n.pubkey))];
            this._feedProfiles = await NostrSocial.fetchProfiles(authorPubkeys);

            this._renderFeed();

            this._feedReactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
            const noteIds = allNotes.map(n => n.id);
            this._loadFeedReactions(noteIds);
            this._loadFeedReplyCounts(noteIds);
        },

        _navigateToThread(noteId) {
            if (typeof Router !== 'undefined') {
                Router.navigate(`/thread.html?id=${noteId}`);
            } else {
                window.location.href = `/thread.html?id=${noteId}`;
            }
        },

        async _loadFeedReplyCounts(noteIds) {
            if (noteIds.length === 0) return;
            const counts = await NostrSocial.fetchReplyCounts(noteIds);
            counts.forEach((count, noteId) => {
                const el = document.querySelector(`.reply-count[data-reply-note-id="${noteId}"]`);
                if (el && count > 0) el.textContent = count;
            });
        },

        _switchFeedTab(tab) {
            if (tab === this._currentFeedTab) return;
            this._currentFeedTab = tab;

            document.querySelectorAll('.feed-sub-tab').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tab);
            });

            this._loadFeed(tab).catch(err => {
                console.error('Failed to load feed:', err);
                const feedEl = document.getElementById('feed-list');
                if (feedEl) {
                    feedEl.innerHTML = `
                        <div class="empty-area">
                            <p>Could not load feed</p>
                            <p class="sub"><a href="#" onclick="switchFeedTab('${tab}'); return false;">Retry</a></p>
                        </div>`;
                }
            });
        },

        // ===== Feed Rendering =====

        _renderFeed() {
            const escapeHtml = NostrSocial.escapeHtml;
            const feedEl = document.getElementById('feed-list');
            if (!feedEl) return;

            feedEl.innerHTML = this._feedNotes.map(note => {
                const profile = this._feedProfiles.get(note.pubkey) || {};
                const name = profile.name || 'Nostr User';
                const initial = name.charAt(0).toUpperCase();
                const time = NostrSocial.relativeTime(note.created_at);
                const isPlaylistShare = note.tags?.some(t => t[0] === 'content-type' && t[1] === 'playlist-share');
                const isReleaseAnnouncement = note.tags?.some(t => t[0] === 'content-type' && t[1] === 'release-announcement');
                const content = NostrSocial.linkifyContent(escapeHtml(note.content));
                const likeCount = this._feedReactionData.likes[note.id] || 0;
                const repostCount = this._feedReactionData.reposts[note.id] || 0;
                const userLiked = this._feedReactionData.userLiked.has(note.id);
                const userReposted = this._feedReactionData.userReposted.has(note.id);

                let npub = '';
                try { npub = window.NostrTools.nip19.npubEncode(note.pubkey); } catch (e) {}

                const avatarLink = npub ? `<a href="user.html?npub=${npub}">` : '';
                const avatarLinkEnd = npub ? '</a>' : '';

                return `
                    <div class="feed-post" data-note-id="${note.id}">
                        <div class="feed-post-inner feed-post-clickable" onclick="navigateToThread('${note.id}')">
                            <div class="feed-avatar" onclick="event.stopPropagation()">
                                ${avatarLink}
                                ${profile.picture
                                    ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                    : initial
                                }
                                ${avatarLinkEnd}
                            </div>
                            <div class="feed-post-body">
                                <div class="feed-post-header">
                                    <span class="feed-display-name" onclick="event.stopPropagation()">${npub ? `<a href="user.html?npub=${npub}">${escapeHtml(name)}</a>` : escapeHtml(name)}</span>
                                    ${!NostrSocial.isEqualiiserEvent(note) ? '<span class="feed-nostr-badge">via NOSTR</span>' : ''}
                                    <span class="feed-handle">${npub ? npub.substring(0, 16) + '...' : ''}</span>
                                    <span class="feed-time">${time}</span>
                                </div>
                                <div class="feed-content">${content}</div>
                                ${NostrSocial.generateLinkPreviews(note.content)}
                                ${isPlaylistShare ? this._renderPlaylistShareCard(note) : ''}
                                ${isReleaseAnnouncement ? NostrSocial.generateReleaseAnnouncementCard(note) : ''}
                                <div class="feed-actions" onclick="event.stopPropagation()">
                                    <div class="feed-action reply-btn" onclick="navigateToThread('${note.id}')">
                                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z"/>
                                        </svg>
                                        <span class="reply-count" data-reply-note-id="${note.id}"></span>
                                    </div>
                                    <div class="feed-action like-btn${userLiked ? ' liked' : ''}" onclick="handleFeedLike('${note.id}', '${note.pubkey}')">
                                        <svg viewBox="0 0 20 20" fill="${userLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">
                                            <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/>
                                        </svg>
                                        <span class="like-count">${likeCount || ''}</span>
                                    </div>
                                    <div class="feed-action repost-btn${userReposted ? ' reposted' : ''}" onclick="handleFeedRepost('${note.id}', '${note.pubkey}')">
                                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M7 16V4m0 0L3 8m4-4l4 4M13 4v12m0 0l4-4m-4 4l-4-4"/>
                                        </svg>
                                        <span class="repost-count">${repostCount || ''}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>`;
            }).join('');
        },

        _renderPlaylistShareCard(note) {
            const aTag = note.tags?.find(t => t[0] === 'a');
            if (!aTag) return '';
            const parts = aTag[1].split(':');
            if (parts.length < 3 || parts[0] !== '30001') return '';
            const pubkey = parts[1];
            const dTag = parts[2];
            const cardId = `playlist-card-${note.id.substring(0, 8)}`;
            return `
                <div class="feed-playlist-card" id="${cardId}" data-pubkey="${pubkey}" data-dtag="${dTag}" onclick="expandPlaylistCard('${cardId}')">
                    <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20" style="opacity:0.6;flex-shrink:0"><path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/></svg>
                    <span>View Playlist</span>
                    <svg class="feed-playlist-chevron" width="16" height="16" fill="currentColor" viewBox="0 0 20 20" style="opacity:0.4;margin-left:auto;transition:transform 0.2s"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
                </div>`;
        },

        async _expandPlaylistCard(cardId) {
            const card = document.getElementById(cardId);
            if (!card || card.dataset.expanded === 'true') return;
            card.dataset.expanded = 'true';
            card.onclick = null;

            const pubkey = card.dataset.pubkey;
            const dTag = card.dataset.dtag;

            // Rotate chevron
            const chevron = card.querySelector('.feed-playlist-chevron');
            if (chevron) chevron.style.transform = 'rotate(180deg)';

            // Show loading
            const trackListId = `${cardId}-tracks`;
            card.insertAdjacentHTML('afterend', `<div class="feed-playlist-tracklist" id="${trackListId}"><div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">Loading tracks...</div></div>`);

            try {
                const playlist = await NostrPlaylists.fetchPlaylist(pubkey, dTag);
                if (!playlist || playlist.trackIds.length === 0) {
                    document.getElementById(trackListId).innerHTML = `<div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">No tracks in this playlist</div>`;
                    return;
                }

                // Update card header with playlist name
                const nameSpan = card.querySelector('span');
                if (nameSpan) nameSpan.textContent = playlist.title || 'Playlist';

                const tracks = await NostrPlaylists.resolveTrackEvents(playlist.trackIds);
                if (tracks.length === 0) {
                    document.getElementById(trackListId).innerHTML = `<div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">Could not load tracks</div>`;
                    return;
                }

                // Store tracks on card element for playback
                card._resolvedTracks = tracks;

                const escapeHtml = NostrSocial.escapeHtml;
                const trackListHtml = tracks.map((t, i) => {
                    const duration = t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, '0')}` : '';
                    const coverHtml = t.blossomCoverUrl
                        ? `<img src="${escapeHtml(t.blossomCoverUrl)}" alt="" onerror="this.style.display='none'">`
                        : (t.coverArtCid ? `<img src="/ipfs/${t.coverArtCid}" alt="" onerror="this.style.display='none'">` : '');
                    return `
                        <div class="feed-playlist-track" onclick="event.stopPropagation(); playFromPlaylistCard('${cardId}', ${i})">
                            <div class="feed-playlist-track-cover">${coverHtml}</div>
                            <div class="feed-playlist-track-info">
                                <div class="feed-playlist-track-title">${escapeHtml(t.title)}</div>
                                <div class="feed-playlist-track-artist">${escapeHtml(t.artist || 'Unknown Artist')}</div>
                            </div>
                            <div class="feed-playlist-track-duration">${duration}</div>
                            <svg class="feed-playlist-track-play" width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 3.5v13l10-6.5z"/></svg>
                        </div>`;
                }).join('');

                document.getElementById(trackListId).innerHTML = `
                    <div class="feed-playlist-actions">
                        <button class="feed-playlist-play-all" onclick="event.stopPropagation(); playFromPlaylistCard('${cardId}', 0)">
                            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 3.5v13l10-6.5z"/></svg>
                            Play All
                        </button>
                        <span class="feed-playlist-count">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</span>
                        <a href="/playlist.html?pubkey=${pubkey}&d=${dTag}" class="feed-playlist-open" onclick="event.stopPropagation()">Open</a>
                        ${(typeof SessionManager !== 'undefined' && SessionManager.hasSession()) ? `<button class="add-to-library-btn" onclick="event.stopPropagation(); addPlaylistToLibrary('${pubkey}', '${dTag}', this)">+ Add to Library</button>` : ''}
                    </div>
                    ${trackListHtml}`;

                // Make card header toggle collapse
                card.onclick = () => {
                    const el = document.getElementById(trackListId);
                    if (!el) return;
                    const hidden = el.style.display === 'none';
                    el.style.display = hidden ? '' : 'none';
                    if (chevron) chevron.style.transform = hidden ? 'rotate(180deg)' : '';
                };
            } catch (err) {
                console.error('Failed to load playlist:', err);
                document.getElementById(trackListId).innerHTML = `<div style="padding:12px;color:rgba(255,255,255,0.4);font-size:13px;">Failed to load playlist</div>`;
            }
        },

        _playFromPlaylistCard(cardId, index) {
            const card = document.getElementById(cardId);
            if (!card || !card._resolvedTracks) return;
            const playerTracks = card._resolvedTracks.map(t => ({
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

        // ===== Feed Reactions =====

        async _loadFeedReactions(noteIds) {
            if (noteIds.length === 0) return;
            this._feedReactionData = await NostrSocial.fetchReactions(noteIds);
            this._updateFeedReactionUI();
        },

        _updateFeedReactionUI() {
            document.querySelectorAll('#feed-list .feed-post').forEach(post => {
                const noteId = post.dataset.noteId;
                if (!noteId) return;

                const likeBtn = post.querySelector('.like-btn');
                const repostBtn = post.querySelector('.repost-btn');

                if (likeBtn) {
                    const count = this._feedReactionData.likes[noteId] || 0;
                    likeBtn.querySelector('.like-count').textContent = count || '';
                    const liked = this._feedReactionData.userLiked.has(noteId);
                    likeBtn.classList.toggle('liked', liked);
                    likeBtn.querySelector('svg').setAttribute('fill', liked ? 'currentColor' : 'none');
                }

                if (repostBtn) {
                    const count = this._feedReactionData.reposts[noteId] || 0;
                    repostBtn.querySelector('.repost-count').textContent = count || '';
                    repostBtn.classList.toggle('reposted', this._feedReactionData.userReposted.has(noteId));
                }
            });
        },

        async _handleFeedLike(noteId, authorPubkey) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }
            if (this._feedReactionData.userLiked.has(noteId)) return;

            try {
                const event = {
                    kind: 7,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['e', noteId], ['p', authorPubkey]],
                    content: '+'
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._feedReactionData.likes[noteId] = (this._feedReactionData.likes[noteId] || 0) + 1;
                this._feedReactionData.userLiked.add(noteId);
                this._updateFeedReactionUI();
            } catch (error) {
                console.error('Like failed:', error);
            }
        },

        async _handleFeedRepost(noteId, authorPubkey) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }
            if (this._feedReactionData.userReposted.has(noteId)) return;

            try {
                const originalNote = this._feedNotes.find(n => n.id === noteId);
                const event = {
                    kind: 6,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['e', noteId, NostrSocial.DEFAULT_RELAYS[0]], ['p', authorPubkey]],
                    content: originalNote ? JSON.stringify(originalNote) : ''
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._feedReactionData.reposts[noteId] = (this._feedReactionData.reposts[noteId] || 0) + 1;
                this._feedReactionData.userReposted.add(noteId);
                this._updateFeedReactionUI();
            } catch (error) {
                console.error('Repost failed:', error);
            }
        },

        // ================================================
        // COMMUNITY FUNCTIONALITY
        // ================================================

        async _loadThreads(board) {
            board = board || this._currentBoard;
            const listEl = document.getElementById('thread-list');
            if (!listEl) return;

            listEl.innerHTML = `<div class="loading-area"><div class="loading-spinner"></div><div>Loading threads...</div></div>`;

            this._threads = await NostrSocial.fetchCommunityThreads(board);

            if (this._threads.length === 0) {
                listEl.innerHTML = `<div class="empty-area"><p>No threads yet</p><p class="sub">Start a discussion by creating a new thread</p></div>`;
                return;
            }

            const pubkeys = [...new Set(this._threads.map(t => t.pubkey))];
            this._threadProfiles = await NostrSocial.fetchProfiles(pubkeys);

            const threadIds = this._threads.map(t => t.id);
            this._threadReplyCounts = await NostrSocial.fetchReplyCounts(threadIds);

            this._renderThreadList();
        },

        _renderThreadList() {
            const escapeHtml = NostrSocial.escapeHtml;
            const listEl = document.getElementById('thread-list');
            if (!listEl) return;

            listEl.innerHTML = this._threads.map(thread => {
                const profile = this._threadProfiles.get(thread.pubkey) || {};
                const name = profile.name || 'Unknown';
                const initial = name.charAt(0).toUpperCase();
                const subject = thread.tags.find(t => t[0] === 'subject');
                const board = thread.tags.find(t => t[0] === 'board');
                const boardName = board ? board[1] : 'general';
                const subjectText = subject ? subject[1] : 'Untitled';
                const time = NostrSocial.relativeTime(thread.created_at);
                const replyCount = this._threadReplyCounts.get(thread.id) || 0;
                const preview = thread.content.substring(0, 120) + (thread.content.length > 120 ? '...' : '');

                return `
                    <div class="thread-item" onclick="openThread('${thread.id}')">
                        <div class="thread-item-top">
                            <span class="thread-subject">${escapeHtml(subjectText)}</span>
                            <span class="board-badge ${boardName}">${escapeHtml(boardName)}</span>
                        </div>
                        <div class="thread-preview">${escapeHtml(preview)}</div>
                        <div class="thread-meta">
                            <span class="thread-author">
                                <span class="thread-author-avatar">
                                    ${profile.picture
                                        ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                        : initial
                                    }
                                </span>
                                ${escapeHtml(name)}
                            </span>
                            <span>${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
                            <span>${time}</span>
                        </div>
                    </div>`;
            }).join('');
        },

        _switchBoard(board) {
            if (board === this._currentBoard) return;
            this._currentBoard = board;
            document.querySelectorAll('.board-tab').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.board === board);
            });
            this._loadThreads(board);

            const url = new URL(window.location);
            url.searchParams.set('tab', 'community');
            if (board === 'all') url.searchParams.delete('board');
            else url.searchParams.set('board', board);
            url.searchParams.delete('thread');
            history.replaceState({}, '', url);
        },

        // ===== New Thread =====

        _toggleNewThreadForm() {
            const form = document.getElementById('new-thread-form');
            if (form) form.classList.toggle('visible');
        },

        _wireThreadFormValidation() {
            const subjectInput = document.getElementById('thread-subject');
            const contentInput = document.getElementById('thread-content');
            const submitBtn = document.getElementById('submit-thread-btn');
            if (!subjectInput || !contentInput || !submitBtn) return;

            const validate = () => {
                submitBtn.disabled = !subjectInput.value.trim() || !contentInput.value.trim() || this._isSubmitting;
            };
            subjectInput.addEventListener('input', validate);
            contentInput.addEventListener('input', validate);
        },

        async _submitThread() {
            const subject = (document.getElementById('thread-subject')?.value || '').trim();
            const content = (document.getElementById('thread-content')?.value || '').trim();
            const board = document.getElementById('thread-board')?.value || 'general';
            if (!subject || !content || this._isSubmitting) return;

            const session = SessionManager.getSession();
            if (!session) return;

            this._isSubmitting = true;
            const btn = document.getElementById('submit-thread-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Posting...'; }

            try {
                const event = {
                    kind: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['app', 'Equaliser'],
                        ['content-type', 'thread'],
                        ['subject', subject],
                        ['board', board]
                    ],
                    content: content
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                const subjectEl = document.getElementById('thread-subject');
                const contentEl = document.getElementById('thread-content');
                if (subjectEl) subjectEl.value = '';
                if (contentEl) contentEl.value = '';
                const form = document.getElementById('new-thread-form');
                if (form) form.classList.remove('visible');

                this._loadThreads();
            } catch (error) {
                console.error('Thread creation failed:', error);
                alert('Failed to create thread. Please try again.');
            } finally {
                this._isSubmitting = false;
                if (btn) { btn.disabled = false; btn.textContent = 'Post Thread'; }
            }
        },

        // ===== Thread Detail =====

        async _openThread(threadId) {
            this._activeThreadId = threadId;
            const listView = document.getElementById('community-list-view');
            if (listView) listView.style.display = 'none';
            const detailView = document.getElementById('community-detail-view');
            if (detailView) detailView.classList.add('visible');
            const detailContent = document.getElementById('thread-detail-content');
            if (detailContent) detailContent.innerHTML = `<div class="loading-area"><div class="loading-spinner"></div><div>Loading thread...</div></div>`;

            // Update URL with replaceState
            const url = new URL(window.location);
            url.searchParams.set('tab', 'community');
            url.searchParams.set('thread', threadId);
            history.replaceState({}, '', url);

            this._activeThreadEvent = await NostrSocial.fetchEventById(threadId);
            if (!this._activeThreadEvent) {
                if (detailContent) detailContent.innerHTML = `<div class="empty-area"><p>Thread not found</p></div>`;
                return;
            }

            this._activeThreadReplies = await NostrSocial.fetchCommunityReplies(threadId);

            const allPubkeys = new Set([this._activeThreadEvent.pubkey, ...this._activeThreadReplies.map(r => r.pubkey)]);
            this._activeThreadProfiles = await NostrSocial.fetchProfiles([...allPubkeys]);

            this._renderThreadDetail();
        },

        _renderThreadDetail() {
            const escapeHtml = NostrSocial.escapeHtml;
            const ev = this._activeThreadEvent;
            const profile = this._activeThreadProfiles.get(ev.pubkey) || {};
            const name = profile.name || 'Unknown';
            const initial = name.charAt(0).toUpperCase();
            const subject = ev.tags.find(t => t[0] === 'subject');
            const subjectText = subject ? subject[1] : 'Untitled';
            const content = NostrSocial.linkifyContent(escapeHtml(ev.content));
            const date = new Date(ev.created_at * 1000);
            const timeStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            let npub = '';
            try { npub = window.NostrTools.nip19.npubEncode(ev.pubkey); } catch (e) {}

            const session = SessionManager.getSession();
            let composerHtml = '';
            if (session) {
                composerHtml = `
                    <div class="thread-reply-composer">
                        <textarea id="detail-reply-text" placeholder="Write a reply..." maxlength="2000"></textarea>
                        <div class="thread-reply-composer-footer">
                            <button class="form-submit" id="detail-reply-btn" disabled onclick="submitThreadReply()">Reply</button>
                        </div>
                    </div>`;
            } else {
                composerHtml = `<div class="reply-login"><a href="/login.html?return=${encodeURIComponent(window.location.href)}">Log in</a> to reply</div>`;
            }

            let repliesHtml = '';
            if (this._activeThreadReplies.length > 0) {
                repliesHtml = `<div class="thread-replies-header">${this._activeThreadReplies.length} ${this._activeThreadReplies.length === 1 ? 'Reply' : 'Replies'}</div>`;
                repliesHtml += this._activeThreadReplies.map(reply => {
                    const rp = this._activeThreadProfiles.get(reply.pubkey) || {};
                    const rName = rp.name || 'Unknown';
                    const rInitial = rName.charAt(0).toUpperCase();
                    const rContent = NostrSocial.linkifyContent(escapeHtml(reply.content));
                    const rTime = NostrSocial.relativeTime(reply.created_at);
                    let rNpub = '';
                    try { rNpub = window.NostrTools.nip19.npubEncode(reply.pubkey); } catch (e) {}

                    return `
                        <div class="thread-reply-item">
                            <div class="thread-reply-inner">
                                <div class="thread-reply-avatar">
                                    ${rNpub ? `<a href="/user.html?npub=${rNpub}" style="display:contents">` : ''}
                                    ${rp.picture
                                        ? `<img src="${escapeHtml(rp.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${rInitial}'">`
                                        : rInitial
                                    }
                                    ${rNpub ? '</a>' : ''}
                                </div>
                                <div class="thread-reply-body">
                                    <div class="thread-reply-header">
                                        <span class="thread-reply-name">${rNpub ? `<a href="/user.html?npub=${rNpub}">${escapeHtml(rName)}</a>` : escapeHtml(rName)}</span>
                                        <span class="thread-reply-time">${rTime}</span>
                                    </div>
                                    <div class="thread-reply-content">${rContent}</div>
                                </div>
                            </div>
                        </div>`;
                }).join('');
            } else {
                repliesHtml = `<div class="thread-replies-empty">No replies yet. Be the first to reply!</div>`;
            }

            const board = ev.tags.find(t => t[0] === 'board');
            const boardName = board ? board[1] : 'general';

            const detailContent = document.getElementById('thread-detail-content');
            if (!detailContent) return;

            detailContent.innerHTML = `
                <div class="thread-op">
                    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
                        <span class="board-badge ${boardName}">${escapeHtml(boardName)}</span>
                    </div>
                    <div class="thread-op-subject">${escapeHtml(subjectText)}</div>
                    <div class="thread-op-header">
                        <div class="thread-op-avatar">
                            ${npub ? `<a href="/user.html?npub=${npub}" style="display:contents">` : ''}
                            ${profile.picture
                                ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                : initial
                            }
                            ${npub ? '</a>' : ''}
                        </div>
                        <div>
                            <div class="thread-op-author-name">${npub ? `<a href="/user.html?npub=${npub}">${escapeHtml(name)}</a>` : escapeHtml(name)}</div>
                            <div class="thread-op-time">${timeStr}</div>
                        </div>
                    </div>
                    <div class="thread-op-content">${content}</div>
                </div>
                ${composerHtml}
                ${repliesHtml}`;

            if (session) {
                const textarea = document.getElementById('detail-reply-text');
                const replyBtn = document.getElementById('detail-reply-btn');
                if (textarea && replyBtn) {
                    textarea.addEventListener('input', () => {
                        replyBtn.disabled = textarea.value.trim().length === 0 || this._isSubmitting;
                    });
                    textarea.addEventListener('keydown', (e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault();
                            if (!replyBtn.disabled) this._submitThreadReply();
                        }
                    });
                }
            }
        },

        async _submitThreadReply() {
            const textarea = document.getElementById('detail-reply-text');
            const btn = document.getElementById('detail-reply-btn');
            const content = (textarea?.value || '').trim();
            if (!content || this._isSubmitting) return;

            const session = SessionManager.getSession();
            if (!session) return;

            this._isSubmitting = true;
            if (btn) { btn.disabled = true; btn.textContent = 'Posting...'; }

            try {
                const event = {
                    kind: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [
                        ['app', 'Equaliser'],
                        ['content-type', 'reply'],
                        ['e', this._activeThreadId, '', 'root'],
                        ['p', this._activeThreadEvent.pubkey]
                    ],
                    content: content
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._activeThreadReplies.push(signedEvent);
                if (!this._activeThreadProfiles.has(signedEvent.pubkey)) {
                    const profiles = await NostrSocial.fetchProfiles([signedEvent.pubkey]);
                    profiles.forEach((v, k) => this._activeThreadProfiles.set(k, v));
                }

                if (textarea) textarea.value = '';
                this._renderThreadDetail();
            } catch (error) {
                console.error('Reply failed:', error);
                alert('Failed to post reply. Please try again.');
            } finally {
                this._isSubmitting = false;
                if (btn) { btn.disabled = false; btn.textContent = 'Reply'; }
            }
        },

        _showCommunityListView() {
            const detailView = document.getElementById('community-detail-view');
            if (detailView) detailView.classList.remove('visible');
            const listView = document.getElementById('community-list-view');
            if (listView) listView.style.display = '';
            this._activeThreadId = null;

            const url = new URL(window.location);
            url.searchParams.delete('thread');
            url.searchParams.set('tab', 'community');
            history.replaceState({}, '', url);
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.social = SocialPage;
})();
