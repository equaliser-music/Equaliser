/**
 * User Page Module
 *
 * Public user profile viewer with posts, follow, and reactions.
 * Extracted from user.html for use with the app shell router.
 */
(function() {
    'use strict';

    const DEFAULT_RELAYS = (typeof NostrSocial !== 'undefined') ? NostrSocial.DEFAULT_RELAYS : [];

    const UserPage = {
        _userProfile: null,
        _feedNotes: [],
        _reactionData: { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() },
        _isFollowing: false,
        _userContactTags: [],
        _userContactContent: '',

        init(params) {
            // Expose global functions
            window.loadUser = (npub) => this._loadUser(npub);
            window.copyNpub = (npub) => this._copyNpub(npub);
            window.handleLike = (id, pk) => this._handleLike(id, pk);
            window.handleRepost = (id, pk) => this._handleRepost(id, pk);
            window.toggleFollow = (pk) => this._toggleFollow(pk);
            window.isOwnProfile = (pk) => this._isOwnProfile(pk);

            const urlParams = new URLSearchParams(window.location.search);
            const npub = urlParams.get('npub');

            if (npub) {
                this._loadUser(npub);
            } else {
                const el = document.getElementById('main-content');
                if (el) el.innerHTML = `
                    <div class="error">
                        <h2 class="error-title">No user specified</h2>
                        <p class="error-message">Please provide an npub in the URL</p>
                        <button class="btn btn-primary" onclick="history.back()">Go Back</button>
                    </div>`;
            }
        },

        cleanup() {
            delete window.loadUser;
            delete window.copyNpub;
            delete window.handleLike;
            delete window.handleRepost;
            delete window.toggleFollow;
            delete window.isOwnProfile;
            this._userProfile = null;
            this._feedNotes = [];
            this._reactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
            this._isFollowing = false;
            this._userContactTags = [];
            this._userContactContent = '';
        },

        // ===== Load User =====

        async _loadUser(npub) {
            const mainContent = document.getElementById('main-content');
            const escapeHtml = NostrSocial.escapeHtml;

            try {
                let pubkeyHex;
                try {
                    const decoded = NostrTools.nip19.decode(npub);
                    if (decoded.type !== 'npub') throw new Error('Invalid npub');
                    pubkeyHex = decoded.data;
                } catch (e) {
                    throw new Error('Invalid npub format');
                }

                // Check for tracks - if artist, redirect
                const tracks = await this._checkForTracks(pubkeyHex);
                if (tracks.length > 0) {
                    if (typeof Router !== 'undefined') {
                        Router.navigate('artist.html?npub=' + npub);
                    } else {
                        window.location.replace('artist.html?npub=' + npub);
                    }
                    return;
                }

                const profile = await this._fetchProfile(pubkeyHex);
                if (!profile) throw new Error('User not found on relay');

                this._userProfile = profile;
                document.title = (profile.name || 'User') + ' - Equaliser';
                this._renderUser(npub, pubkeyHex);

                this._checkFollowStatus(pubkeyHex);
                this._loadFeed(pubkeyHex);

            } catch (error) {
                console.error('Error loading user:', error);
                if (mainContent) mainContent.innerHTML = `
                    <div class="error">
                        <h2 class="error-title">Could not load profile</h2>
                        <p class="error-message">${escapeHtml(error.message)}</p>
                        <button class="btn btn-primary" onclick="history.back()">Go Back</button>
                    </div>`;
            }
        },

        // ===== Relay Queries =====

        _fetchProfileFromRelay(relayUrl, pubkeyHex) {
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                let profile = null;
                const timeout = setTimeout(() => { ws.close(); resolve(null); }, 8000);
                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', 'profile-' + Date.now(), { kinds: [0], authors: [pubkeyHex], limit: 1 }]));
                };
                ws.onmessage = (e) => {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'EVENT') { try { profile = JSON.parse(data[2].content); profile._event = data[2]; } catch (err) {} }
                    if (data[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(profile); }
                };
                ws.onerror = () => { clearTimeout(timeout); resolve(null); };
            });
        },

        async _fetchProfile(pubkeyHex) {
            const results = await Promise.all(DEFAULT_RELAYS.map(r => this._fetchProfileFromRelay(r, pubkeyHex)));
            for (const profile of results) { if (profile) return profile; }
            return null;
        },

        _checkForTracks(pubkeyHex) {
            return new Promise((resolve) => {
                const relay = DEFAULT_RELAYS[0];
                const ws = new WebSocket(relay);
                const tracks = [];
                const timeout = setTimeout(() => { ws.close(); resolve(tracks); }, 5000);
                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', 'tracks-' + Date.now(), { kinds: [30050], authors: [pubkeyHex], limit: 1 }]));
                };
                ws.onmessage = (e) => {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'EVENT') tracks.push(data[2]);
                    if (data[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(tracks); }
                };
                ws.onerror = () => { clearTimeout(timeout); resolve(tracks); };
            });
        },

        // ===== Render =====

        _renderUser(npub, pubkeyHex) {
            const mainContent = document.getElementById('main-content');
            const escapeHtml = NostrSocial.escapeHtml;
            const profile = this._userProfile;

            const initials = (profile.name || 'U').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            const shortNpub = npub.substring(0, 12) + '...' + npub.substring(npub.length - 6);

            mainContent.innerHTML = `
                <div class="user-banner">
                    ${profile.banner ? `<img src="${profile.banner}" alt="">` : ''}
                </div>
                <div class="user-header">
                    <div class="user-avatar">
                        ${profile.picture ? `<img src="${profile.picture}" alt="${escapeHtml(profile.name || '')}">` : initials}
                    </div>
                    <div class="user-info">
                        <h1 class="user-name">${escapeHtml(profile.name || profile.display_name || 'Unknown')}</h1>
                        <div class="user-meta">
                            ${profile.nip05 ? `<span>${escapeHtml(profile.nip05)}</span>` : ''}
                            <span class="npub-tag" onclick="copyNpub('${npub}')" title="Click to copy">${shortNpub}</span>
                        </div>
                    </div>
                </div>
                <div class="user-actions">
                    ${!this._isOwnProfile(pubkeyHex) ? `
                        <button class="btn btn-primary" id="follow-btn" onclick="toggleFollow('${pubkeyHex}')" disabled>
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6z"/>
                                <path d="M16 7a1 1 0 10-2 0v1h-1a1 1 0 100 2h1v1a1 1 0 102 0v-1h1a1 1 0 100-2h-1V7z"/>
                            </svg>
                            Follow
                        </button>
                        <button class="btn btn-secondary" onclick="Router.navigate('/messages.html?npub=${npub}')">
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z"/>
                                <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/>
                            </svg>
                            Message
                        </button>
                    ` : ''}
                    <button class="btn btn-secondary" onclick="copyNpub('${npub}')">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/>
                            <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/>
                        </svg>
                        Copy npub
                    </button>
                </div>
                ${profile.about ? `
                    <div class="user-bio">
                        <div class="bio-text">${NostrSocial.linkifyContent(escapeHtml(profile.about))}</div>
                    </div>` : ''}
                <div class="posts-section">
                    <h2 class="section-title">Posts</h2>
                    <div id="feed-content">
                        <div class="loading"><div class="loading-spinner"></div></div>
                    </div>
                </div>`;
        },

        // ===== Feed =====

        async _loadFeed(pubkeyHex) {
            const container = document.getElementById('feed-content');
            if (!container) return;
            const escapeHtml = NostrSocial.escapeHtml;

            let allNotes = await NostrSocial.fetchNotes({ kinds: [1], authors: [pubkeyHex], limit: 50 });
            allNotes = allNotes.filter(n => NostrSocial.isEqualiiserEvent(n) && NostrSocial.isTopLevelPost(n));

            if (allNotes.length === 0) {
                container.innerHTML = `
                    <div class="feed-empty">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                        </svg>
                        <p>No posts yet</p>
                    </div>`;
                return;
            }

            this._feedNotes = allNotes;
            this._renderFeed(allNotes);

            const noteIds = allNotes.map(n => n.id);
            this._loadReactions(noteIds);
            this._loadReplyCounts(noteIds);
        },

        async _loadReplyCounts(noteIds) {
            if (noteIds.length === 0) return;
            const counts = await NostrSocial.fetchReplyCounts(noteIds);
            counts.forEach((count, noteId) => {
                const el = document.querySelector(`.reply-count[data-reply-note-id="${noteId}"]`);
                if (el && count > 0) el.textContent = count;
            });
        },

        _renderFeed(notes) {
            const container = document.getElementById('feed-content');
            if (!container) return;
            const escapeHtml = NostrSocial.escapeHtml;
            const profile = this._userProfile || {};
            const avatarInitial = (profile.name || 'U').charAt(0).toUpperCase();

            container.innerHTML = notes.map(note => {
                const content = NostrSocial.linkifyContent(escapeHtml(note.content));
                const time = NostrSocial.relativeTime(note.created_at);
                const likeCount = this._reactionData.likes[note.id] || 0;
                const repostCount = this._reactionData.reposts[note.id] || 0;
                const userLiked = this._reactionData.userLiked.has(note.id);
                const userReposted = this._reactionData.userReposted.has(note.id);

                return `
                    <div class="feed-item" data-note-id="${note.id}">
                        <div class="feed-item-header">
                            <div class="feed-avatar">
                                ${profile.picture
                                    ? `<img src="${profile.picture}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${avatarInitial}'">`
                                    : avatarInitial
                                }
                            </div>
                            <span class="feed-author-name">${escapeHtml(profile.name || 'User')}</span>
                            <span class="feed-time">${time}</span>
                        </div>
                        <div class="feed-content" style="cursor:pointer" onclick="Router.navigate('/thread.html?id=${note.id}')">${content}</div>
                        <div class="feed-actions">
                            <button class="feed-action-btn reply-btn" onclick="Router.navigate('/thread.html?id=${note.id}')">
                                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z"/>
                                </svg>
                                <span class="reply-count" data-reply-note-id="${note.id}"></span>
                            </button>
                            <button class="feed-action-btn like-btn${userLiked ? ' liked' : ''}" onclick="handleLike('${note.id}', '${note.pubkey}')">
                                <svg viewBox="0 0 20 20" fill="${userLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">
                                    <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/>
                                </svg>
                                <span class="like-count">${likeCount || ''}</span>
                            </button>
                            <button class="feed-action-btn repost-btn${userReposted ? ' reposted' : ''}" onclick="handleRepost('${note.id}', '${note.pubkey}')">
                                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M7 16V4m0 0L3 8m4-4l4 4M13 4v12m0 0l4-4m-4 4l-4-4"/>
                                </svg>
                                <span class="repost-count">${repostCount || ''}</span>
                            </button>
                        </div>
                    </div>`;
            }).join('');
        },

        // ===== Reactions =====

        async _loadReactions(noteIds) {
            if (noteIds.length === 0) return;
            this._reactionData = await NostrSocial.fetchReactions(noteIds);
            this._updateReactionUI();
        },

        _updateReactionUI() {
            document.querySelectorAll('.feed-item').forEach(item => {
                const noteId = item.dataset.noteId;
                if (!noteId) return;
                const likeBtn = item.querySelector('.like-btn');
                const repostBtn = item.querySelector('.repost-btn');

                if (likeBtn) {
                    const count = this._reactionData.likes[noteId] || 0;
                    likeBtn.querySelector('.like-count').textContent = count || '';
                    const liked = this._reactionData.userLiked.has(noteId);
                    likeBtn.classList.toggle('liked', liked);
                    likeBtn.querySelector('svg').setAttribute('fill', liked ? 'currentColor' : 'none');
                }

                if (repostBtn) {
                    const count = this._reactionData.reposts[noteId] || 0;
                    repostBtn.querySelector('.repost-count').textContent = count || '';
                    repostBtn.classList.toggle('reposted', this._reactionData.userReposted.has(noteId));
                }
            });
        },

        async _handleLike(noteId, authorPubkey) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }
            if (this._reactionData.userLiked.has(noteId)) return;

            try {
                const event = {
                    kind: 7, created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['e', noteId], ['p', authorPubkey]], content: '+'
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);
                this._reactionData.likes[noteId] = (this._reactionData.likes[noteId] || 0) + 1;
                this._reactionData.userLiked.add(noteId);
                this._updateReactionUI();
            } catch (error) { console.error('Like failed:', error); }
        },

        async _handleRepost(noteId, authorPubkey) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }
            if (this._reactionData.userReposted.has(noteId)) return;

            try {
                const originalNote = this._feedNotes.find(n => n.id === noteId);
                const event = {
                    kind: 6, created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['e', noteId, DEFAULT_RELAYS[0]], ['p', authorPubkey]],
                    content: originalNote ? JSON.stringify(originalNote) : ''
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);
                this._reactionData.reposts[noteId] = (this._reactionData.reposts[noteId] || 0) + 1;
                this._reactionData.userReposted.add(noteId);
                this._updateReactionUI();
            } catch (error) { console.error('Repost failed:', error); }
        },

        // ===== Follow System =====

        _isOwnProfile(pubkeyHex) {
            const session = SessionManager.getSession();
            return session && session.publicKey === pubkeyHex;
        },

        async _checkFollowStatus(targetPubkeyHex) {
            const session = SessionManager.getSession();
            if (!session) {
                const btn = document.getElementById('follow-btn');
                if (btn) btn.disabled = false;
                return;
            }

            try {
                const contactList = await this._fetchContactListRaw(session.publicKey);
                this._userContactTags = contactList.tags;
                this._userContactContent = contactList.content;
                this._isFollowing = this._userContactTags.some(tag => tag[0] === 'p' && tag[1] === targetPubkeyHex);
                this._updateFollowButton();
            } catch (err) {
                console.error('Failed to check follow status:', err);
            }

            const btn = document.getElementById('follow-btn');
            if (btn) btn.disabled = false;
        },

        async _fetchContactListRaw(pubkeyHex) {
            const events = await NostrSocial.fetchNotes({ kinds: [3], authors: [pubkeyHex], limit: 1 });
            if (events.length > 0) return { tags: events[0].tags || [], content: events[0].content || '' };
            return { tags: [], content: '' };
        },

        async _toggleFollow(targetPubkeyHex) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }

            const btn = document.getElementById('follow-btn');
            if (btn) btn.disabled = true;

            try {
                if (this._isFollowing) {
                    this._userContactTags = this._userContactTags.filter(tag => !(tag[0] === 'p' && tag[1] === targetPubkeyHex));
                } else {
                    this._userContactTags.push(['p', targetPubkeyHex]);
                }

                const contactTags = [['app', 'Equaliser'], ...this._userContactTags];
                const event = {
                    kind: 3, created_at: Math.floor(Date.now() / 1000),
                    tags: contactTags, content: this._userContactContent
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._isFollowing = !this._isFollowing;
                this._updateFollowButton();
            } catch (error) {
                console.error('Follow error:', error);
                alert('Failed to update follow: ' + error.message);
            } finally {
                if (btn) btn.disabled = false;
            }
        },

        _updateFollowButton() {
            const btn = document.getElementById('follow-btn');
            if (!btn) return;

            if (this._isFollowing) {
                btn.className = 'btn btn-following';
                btn.innerHTML = `
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                    </svg>
                    Following`;
                btn.onmouseenter = () => {
                    btn.innerHTML = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6z"/><path d="M16 8a1 1 0 01-1 1h-2a1 1 0 110-2h2a1 1 0 011 1z"/></svg> Unfollow`;
                };
                btn.onmouseleave = () => {
                    btn.innerHTML = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Following`;
                };
            } else {
                btn.className = 'btn btn-primary';
                btn.innerHTML = `
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6z"/>
                        <path d="M16 7a1 1 0 10-2 0v1h-1a1 1 0 100 2h1v1a1 1 0 102 0v-1h1a1 1 0 100-2h-1V7z"/>
                    </svg>
                    Follow`;
                btn.onmouseenter = null;
                btn.onmouseleave = null;
            }
        },

        _copyNpub(npub) {
            navigator.clipboard.writeText(npub).then(() => {
                const tag = document.querySelector('.npub-tag');
                if (tag) {
                    const original = tag.textContent;
                    tag.textContent = 'Copied!';
                    setTimeout(() => { tag.textContent = original; }, 1500);
                }
            });
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.user = UserPage;
})();
