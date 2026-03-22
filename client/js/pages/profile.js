/**
 * Profile Page Module
 *
 * User's own profile with posts/likes tabs.
 * Extracted from profile.html for use with the app shell router.
 */
(function() {
    'use strict';

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const relayUrl = `${wsProtocol}//${window.location.host}/relay`;

    const ProfilePage = {
        _profilePubkey: null,
        _isOwnProfile: false,
        _fullNpub: null,
        _profileData: null,
        _activeTab: 'posts',
        _postsData: null,
        _likesData: null,
        _profileCache: {},

        init(params) {
            // Expose global functions for onclick handlers
            window.switchTab = (tab) => this._switchTab(tab);
            window.handleLike = (id, pk, el) => this._handleLike(id, pk, el);
            window.handleRepost = (id, pk, el) => this._handleRepost(id, pk, el);
            window.copyNpub = () => this._copyNpub();

            this._activeTab = 'posts';
            this._postsData = null;
            this._likesData = null;
            this._profileCache = {};

            this._initProfile();
        },

        cleanup() {
            delete window.switchTab;
            delete window.handleLike;
            delete window.handleRepost;
            delete window.copyNpub;
            this._profilePubkey = null;
            this._isOwnProfile = false;
            this._fullNpub = null;
            this._profileData = null;
            this._postsData = null;
            this._likesData = null;
            this._profileCache = {};
        },

        async _initProfile() {
            const urlParams = new URLSearchParams(window.location.search);
            const npubParam = urlParams.get('npub');

            if (npubParam) {
                try {
                    const decoded = NostrTools.nip19.decode(npubParam);
                    if (decoded.type !== 'npub') throw new Error('Invalid npub');
                    this._profilePubkey = decoded.data;
                    this._fullNpub = npubParam;
                } catch (e) {
                    console.error('Invalid npub:', e);
                    const loadingEl = document.getElementById('loading-state');
                    if (loadingEl) loadingEl.innerHTML = '<p style="color: rgba(255,255,255,0.5);">Invalid profile link</p>';
                    return;
                }

                const session = SessionManager.getSession();
                if (session && session.publicKey === this._profilePubkey) {
                    this._isOwnProfile = true;
                }
            } else if (SessionManager.hasSession()) {
                const session = SessionManager.getSession();
                this._profilePubkey = session.publicKey;
                this._fullNpub = session.npub;
                this._isOwnProfile = true;
            } else {
                window.location.href = '/login.html?return=' + encodeURIComponent(window.location.href);
                return;
            }

            if (this._isOwnProfile) {
                const editBtn = document.getElementById('edit-btn');
                if (editBtn) editBtn.style.display = '';
                const msgsBtn = document.getElementById('messages-btn');
                if (msgsBtn) msgsBtn.style.display = '';
            }

            const npubEl = document.getElementById('profile-npub');
            if (npubEl) {
                npubEl.textContent = this._fullNpub.substring(0, 16) + '...' + this._fullNpub.substring(this._fullNpub.length - 8);
            }

            // Wire up tabs
            document.querySelectorAll('.profile-tab').forEach(tab => {
                tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
            });

            await this._loadProfile();
            await this._loadFollowCounts();

            const loadingEl = document.getElementById('loading-state');
            if (loadingEl) loadingEl.style.display = 'none';
            const contentEl = document.getElementById('profile-content');
            if (contentEl) contentEl.style.display = '';

            this._loadPostsTab();
        },

        // ===== Tab Switching =====

        _switchTab(tabName) {
            this._activeTab = tabName;
            document.querySelectorAll('.profile-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.tab === tabName);
            });

            if (tabName === 'posts') this._loadPostsTab();
            else if (tabName === 'likes') this._loadLikesTab();
        },

        // ===== Posts Tab =====

        async _loadPostsTab() {
            const feed = document.getElementById('profile-feed');
            if (!feed) return;

            if (this._postsData) {
                this._renderPostsFeed(this._postsData);
                return;
            }

            feed.innerHTML = '<div class="feed-loading">Loading posts...</div>';

            const events = await this._fetchEventsFromRelay({
                kinds: [1, 6], authors: [this._profilePubkey], limit: 100
            });

            const ownNotes = events.filter(e => e.kind === 1 && NostrSocial.isEqualiiserEvent(e) && NostrSocial.isTopLevelPost(e));
            const reposts = events.filter(e => e.kind === 6 && NostrSocial.isEqualiiserEvent(e));

            const items = [];
            for (const note of ownNotes) {
                items.push({ type: 'post', timestamp: note.created_at, noteId: note.id, authorPubkey: note.pubkey, content: note.content });
            }

            for (const repost of reposts) {
                let originalNote = null;
                if (repost.content) { try { originalNote = JSON.parse(repost.content); } catch (e) {} }
                if (!originalNote) {
                    const eTag = repost.tags.find(t => t[0] === 'e');
                    if (eTag) {
                        const fetched = await this._fetchEventsFromRelay({ ids: [eTag[1]], limit: 1 });
                        if (fetched.length > 0) originalNote = fetched[0];
                    }
                }
                if (originalNote) {
                    items.push({
                        type: 'repost', timestamp: repost.created_at, noteId: originalNote.id,
                        authorPubkey: originalNote.pubkey, content: originalNote.content, repostedBy: repost.pubkey
                    });
                }
            }

            items.sort((a, b) => b.timestamp - a.timestamp);
            this._postsData = items;

            const authorPubkeys = [...new Set(items.map(i => i.authorPubkey))];
            await this._fetchProfiles(authorPubkeys);

            this._renderPostsFeed(items);
        },

        _renderPostsFeed(items) {
            const feed = document.getElementById('profile-feed');
            if (!feed) return;

            if (items.length === 0) {
                feed.innerHTML = `
                    <div class="empty-feed">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                        </svg>
                        <p>No posts yet</p>
                        <p class="sub">Posts and reposts will appear here</p>
                    </div>`;
                return;
            }

            feed.innerHTML = `<div class="feed-items">
                ${items.map(item => this._renderFeedItem(item)).join('')}
            </div>`;
        },

        // ===== Likes Tab =====

        async _loadLikesTab() {
            const feed = document.getElementById('profile-feed');
            if (!feed) return;

            if (this._likesData) {
                this._renderLikesFeed(this._likesData);
                return;
            }

            feed.innerHTML = '<div class="feed-loading">Loading likes...</div>';

            const reactions = await this._fetchEventsFromRelay({
                kinds: [7], authors: [this._profilePubkey], limit: 100
            });

            const likes = reactions.filter(r => r.content !== '-');
            const noteIdsToFetch = [];
            for (const like of likes) {
                const eTag = like.tags.find(t => t[0] === 'e');
                if (eTag) noteIdsToFetch.push(eTag[1]);
            }

            const likedNotes = noteIdsToFetch.length > 0
                ? await this._fetchEventsFromRelay({ ids: noteIdsToFetch, limit: 200 })
                : [];

            const noteMap = new Map();
            likedNotes.forEach(n => noteMap.set(n.id, n));

            const items = [];
            for (const like of likes) {
                const eTag = like.tags.find(t => t[0] === 'e');
                if (!eTag) continue;
                const note = noteMap.get(eTag[1]);
                if (note) {
                    items.push({
                        type: 'liked', timestamp: like.created_at, noteId: note.id,
                        authorPubkey: note.pubkey, content: note.content
                    });
                }
            }

            items.sort((a, b) => b.timestamp - a.timestamp);
            this._likesData = items;

            const authorPubkeys = [...new Set(items.map(i => i.authorPubkey))];
            await this._fetchProfiles(authorPubkeys);

            this._renderLikesFeed(items);
        },

        _renderLikesFeed(items) {
            const feed = document.getElementById('profile-feed');
            if (!feed) return;

            if (items.length === 0) {
                feed.innerHTML = `
                    <div class="empty-feed">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/>
                        </svg>
                        <p>No likes yet</p>
                        <p class="sub">Posts you like will appear here</p>
                    </div>`;
                return;
            }

            feed.innerHTML = `<div class="feed-items">
                ${items.map(item => this._renderFeedItem(item)).join('')}
            </div>`;
        },

        // ===== Feed Rendering =====

        _renderFeedItem(item) {
            const escapeHtml = this._escapeHtml;
            const author = this._profileCache[item.authorPubkey] || {};
            const authorName = author.name || 'Unknown';
            const authorInitial = authorName.charAt(0).toUpperCase();
            const authorNpub = NostrTools.nip19.npubEncode(item.authorPubkey);
            const content = this._linkifyContent(escapeHtml(item.content));
            const time = this._relativeTime(item.timestamp);

            let contextHtml = '';
            if (item.type === 'repost') {
                const repostedByName = this._profileCache[item.repostedBy]?.name || 'You';
                contextHtml = `
                    <div class="feed-item-context">
                        <svg fill="currentColor" viewBox="0 0 20 20"><path d="M7 16V4m0 0L3 8m4-4l4 4M13 4v12m0 0l4-4m-4 4l-4-4"/></svg>
                        ${escapeHtml(repostedByName)} reposted
                    </div>`;
            } else if (item.type === 'liked') {
                contextHtml = `
                    <div class="feed-item-context">
                        <svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>
                        You liked
                    </div>`;
            }

            return `
                <div class="feed-item" data-note-id="${item.noteId}">
                    ${contextHtml}
                    <div class="feed-item-header">
                        <div class="feed-avatar">
                            ${author.picture
                                ? `<img src="${escapeHtml(author.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${authorInitial}'">`
                                : authorInitial
                            }
                        </div>
                        <span class="feed-author-name"><a href="/user.html?npub=${authorNpub}">${escapeHtml(authorName)}</a></span>
                        <span class="feed-time">${time}</span>
                    </div>
                    <div class="feed-item-content" style="cursor:pointer" onclick="Router.navigate('/thread.html?id=${item.noteId}')">${content}</div>
                    ${NostrSocial.generateLinkPreviews(item.content)}
                    <div class="feed-actions">
                        <button class="feed-action-btn reply-btn" onclick="Router.navigate('/thread.html?id=${item.noteId}')">
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z"/>
                            </svg>
                            <span class="reply-count" data-reply-note-id="${item.noteId}"></span>
                        </button>
                        <button class="feed-action-btn like-btn" onclick="handleLike('${item.noteId}', '${item.authorPubkey}', this)">
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/>
                            </svg>
                            <span class="like-count"></span>
                        </button>
                        <button class="feed-action-btn repost-btn${item.type === 'repost' ? ' reposted' : ''}" onclick="handleRepost('${item.noteId}', '${item.authorPubkey}', this)">
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M7 16V4m0 0L3 8m4-4l4 4M13 4v12m0 0l4-4m-4 4l-4-4"/>
                            </svg>
                            <span class="repost-count"></span>
                        </button>
                    </div>
                </div>`;
        },

        // ===== Relay Helpers =====

        _fetchEventsFromRelay(filter) {
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                const events = [];
                const subId = 'q-' + Math.random().toString(36).substring(7);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(events); }, 8000);

                ws.onopen = () => { ws.send(JSON.stringify(['REQ', subId, filter])); };
                ws.onmessage = (e) => {
                    try {
                        const msg = JSON.parse(e.data);
                        if (msg[0] === 'EVENT' && msg[1] === subId) events.push(msg[2]);
                        if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(events); }
                    } catch (err) {}
                };
                ws.onerror = () => { clearTimeout(timeout); resolve(events); };
            });
        },

        _publishToRelay(event) {
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(false); }, 5000);
                ws.onopen = () => { ws.send(JSON.stringify(['EVENT', event])); };
                ws.onmessage = (e) => {
                    try {
                        const msg = JSON.parse(e.data);
                        if (msg[0] === 'OK') { clearTimeout(timeout); ws.close(); resolve(msg[2] === true); }
                    } catch (err) {}
                };
                ws.onerror = () => { clearTimeout(timeout); resolve(false); };
            });
        },

        async _fetchProfiles(pubkeys) {
            const needed = pubkeys.filter(pk => !this._profileCache[pk]);
            if (needed.length === 0) return;

            const events = await this._fetchEventsFromRelay({
                kinds: [0], authors: needed, limit: needed.length
            });

            events.forEach(ev => {
                try {
                    const p = JSON.parse(ev.content);
                    this._profileCache[ev.pubkey] = {
                        name: p.display_name || p.name || 'Unknown',
                        picture: p.picture || null
                    };
                } catch (e) {}
            });

            if (this._profileData && !this._profileCache[this._profilePubkey]) {
                this._profileCache[this._profilePubkey] = {
                    name: this._profileData.display_name || this._profileData.name || 'Unknown',
                    picture: this._profileData.picture || null
                };
            }
        },

        // ===== Like / Repost =====

        async _handleLike(noteId, authorPubkey, btnEl) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = '/login.html?return=' + encodeURIComponent(window.location.href);
                return;
            }
            if (btnEl.classList.contains('liked')) return;

            try {
                const event = {
                    kind: 7,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', noteId], ['p', authorPubkey]],
                    content: '+'
                };
                const signed = await SessionManager.signEvent(event);
                await this._publishToRelay(signed);

                btnEl.classList.add('liked');
                btnEl.querySelector('svg').setAttribute('fill', 'currentColor');
                const countEl = btnEl.querySelector('.like-count');
                const current = parseInt(countEl.textContent) || 0;
                countEl.textContent = current + 1;
            } catch (err) {
                console.error('Like failed:', err);
            }
        },

        async _handleRepost(noteId, authorPubkey, btnEl) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = '/login.html?return=' + encodeURIComponent(window.location.href);
                return;
            }
            if (btnEl.classList.contains('reposted')) return;

            try {
                const event = {
                    kind: 6,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', noteId, relayUrl], ['p', authorPubkey]],
                    content: ''
                };
                const signed = await SessionManager.signEvent(event);
                await this._publishToRelay(signed);

                btnEl.classList.add('reposted');
                const countEl = btnEl.querySelector('.repost-count');
                const current = parseInt(countEl.textContent) || 0;
                countEl.textContent = current + 1;

                this._postsData = null;
            } catch (err) {
                console.error('Repost failed:', err);
            }
        },

        // ===== Profile Loading =====

        async _loadProfile() {
            try {
                if (typeof NostrSocial === 'undefined') return;

                // Query all configured relays (local + external) for the full Kind 0 event
                const events = await NostrSocial.queryRelays({
                    kinds: [0], authors: [this._profilePubkey], limit: 1
                });

                if (events.length > 0) {
                    const profile = JSON.parse(events[0].content);
                    this._profileData = profile;
                    this._profileCache[this._profilePubkey] = {
                        name: profile.display_name || profile.name || 'Unknown',
                        picture: profile.picture || null
                    };
                    this._renderProfile(profile);

                    // Mirror to local relay so future loads are fast
                    NostrSocial.publishToLocal(events[0]);
                }
            } catch (e) {
                console.error('Failed to load profile:', e);
            }
        },

        _renderProfile(profile) {
            const escapeHtml = this._escapeHtml;
            const name = profile.display_name || profile.name || 'Unknown';
            const nameEl = document.getElementById('profile-name');
            if (nameEl) nameEl.textContent = name;
            document.title = `${name} - Equaliser`;

            const avatarEl = document.getElementById('profile-avatar');
            if (avatarEl) {
                if (profile.picture) {
                    avatarEl.innerHTML = `<img src="${profile.picture}" alt="${escapeHtml(name)}" onerror="this.style.display='none'">`;
                } else {
                    const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
                    avatarEl.textContent = initials;
                }
            }

            if (profile.banner) {
                const bannerEl = document.getElementById('profile-banner');
                if (bannerEl) bannerEl.innerHTML = `<img src="${profile.banner}" alt="Banner" onerror="this.style.display='none'">`;
            }

            if (profile.about) {
                const bioEl = document.getElementById('profile-bio');
                if (bioEl) bioEl.textContent = profile.about;
            }

            if (profile.nip05) {
                const nip05El = document.getElementById('profile-nip05');
                if (nip05El) nip05El.style.display = '';
                const nip05Text = document.getElementById('nip05-text');
                if (nip05Text) nip05Text.textContent = profile.nip05;
            }

            if (profile.lud16) {
                const lud16El = document.getElementById('profile-lud16');
                if (lud16El) lud16El.style.display = '';
                const lud16Text = document.getElementById('lud16-text');
                if (lud16Text) lud16Text.textContent = profile.lud16;
            }
        },

        async _loadFollowCounts() {
            const pubkey = this._profilePubkey;

            // Following count: user's Kind 3 contact list
            const followingPromise = (typeof CacheAPI !== 'undefined')
                ? CacheAPI.queryEvents({ kinds: [3], authors: [pubkey], limit: 1 })
                : this._wsQuery({ kinds: [3], authors: [pubkey], limit: 1 });

            // Followers count: Kind 3 events that tag this pubkey
            const followersPromise = (typeof CacheAPI !== 'undefined')
                ? CacheAPI.queryEvents({ kinds: [3], '#p': [pubkey], limit: 500 })
                : this._wsQuery({ kinds: [3], '#p': [pubkey], limit: 500 });

            const [followingEvents, followerEvents] = await Promise.all([followingPromise, followersPromise]);

            if (followingEvents && followingEvents.length > 0) {
                const followingCount = followingEvents[0].tags.filter(t => t[0] === 'p').length;
                const el = document.getElementById('following-count');
                if (el) el.textContent = followingCount;
            }

            if (followerEvents) {
                // Deduplicate by pubkey (one Kind 3 per user)
                const uniqueFollowers = new Set(followerEvents.map(ev => ev.pubkey));
                const el = document.getElementById('followers-count');
                if (el) el.textContent = uniqueFollowers.size;
            }
        },

        _wsQuery(filter) {
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                const events = [];
                const subId = 'q-' + Math.random().toString(36).substring(7);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(events); }, 8000);

                ws.onopen = () => { ws.send(JSON.stringify(['REQ', subId, filter])); };
                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) events.push(msg[2]);
                        if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(events); }
                    } catch (e) {}
                };
                ws.onerror = () => { clearTimeout(timeout); resolve(events); };
            });
        },

        // ===== Utilities =====

        _escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        },

        _linkifyContent(text) {
            return text.replace(
                /(https?:\/\/[^\s<]+)/g,
                '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
            );
        },

        _relativeTime(unixTimestamp) {
            const now = Math.floor(Date.now() / 1000);
            const diff = now - unixTimestamp;
            if (diff < 60) return 'just now';
            if (diff < 3600) return `${Math.floor(diff / 60)}m`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
            if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
            if (diff < 2592000) return `${Math.floor(diff / 604800)}w`;
            const date = new Date(unixTimestamp * 1000);
            return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        },

        async _copyNpub() {
            if (!this._fullNpub) return;
            try {
                await navigator.clipboard.writeText(this._fullNpub);
                const el = document.getElementById('profile-npub');
                if (el) {
                    const original = el.textContent;
                    el.textContent = 'Copied!';
                    el.style.color = '#22c55e';
                    setTimeout(() => { el.textContent = original; el.style.color = ''; }, 1500);
                }
            } catch (e) {}
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.profile = ProfilePage;
})();
