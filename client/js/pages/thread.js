/**
 * Thread Page Module
 *
 * Thread view with root post, replies, reply composer, reactions.
 * Extracted from thread.html for use with the app shell router.
 */
(function() {
    'use strict';

    const ThreadPage = {
        _rootEvent: null,
        _rootAuthorPubkey: null,
        _rootEventId: null,
        _threadReplies: [],
        _threadProfiles: new Map(),
        _threadReactionData: { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() },
        _isReplying: false,

        init(params) {
            // Expose global functions for onclick handlers
            window.submitReply = () => this._submitReply();
            window.handleLike = (id, pk) => this._handleLike(id, pk);
            window.handleRepost = (id, pk) => this._handleRepost(id, pk);

            this._loadThread();
        },

        cleanup() {
            delete window.submitReply;
            delete window.handleLike;
            delete window.handleRepost;
            this._rootEvent = null;
            this._rootAuthorPubkey = null;
            this._rootEventId = null;
            this._threadReplies = [];
            this._threadProfiles = new Map();
            this._threadReactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
        },

        // ===== Thread Loading =====

        async _loadThread() {
            const params = new URLSearchParams(window.location.search);
            this._rootEventId = params.get('id');
            if (!this._rootEventId) {
                this._showError('No thread ID provided');
                return;
            }

            this._rootEvent = await NostrSocial.fetchEventById(this._rootEventId);
            if (!this._rootEvent) {
                this._showError('Thread not found');
                return;
            }
            this._rootAuthorPubkey = this._rootEvent.pubkey;

            this._threadReplies = await NostrSocial.fetchThreadReplies(this._rootEventId);

            const allPubkeys = new Set([this._rootEvent.pubkey, ...this._threadReplies.map(r => r.pubkey)]);
            this._threadProfiles = await NostrSocial.fetchProfiles([...allPubkeys]);

            this._renderThread();

            const allIds = [this._rootEvent.id, ...this._threadReplies.map(r => r.id)];
            this._loadReactions(allIds);
        },

        _showError(msg) {
            const el = document.getElementById('thread-content');
            if (el) el.innerHTML = `
                <div class="thread-error">
                    <p>${msg}</p>
                    <p><a href="/social.html" onclick="event.preventDefault(); Router.navigate('/social.html');">Back to feed</a></p>
                </div>`;
        },

        // ===== Rendering =====

        _renderThread() {
            const escapeHtml = NostrSocial.escapeHtml;
            const ev = this._rootEvent;
            const profile = this._threadProfiles.get(ev.pubkey) || {};
            const name = profile.name || 'Nostr User';
            const initial = name.charAt(0).toUpperCase();
            const content = NostrSocial.linkifyContent(escapeHtml(ev.content));

            let npub = '';
            try { npub = window.NostrTools.nip19.npubEncode(ev.pubkey); } catch (e) {}

            const date = new Date(ev.created_at * 1000);
            const timeStr = date.toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            const likeCount = this._threadReactionData.likes[ev.id] || 0;
            const repostCount = this._threadReactionData.reposts[ev.id] || 0;
            const userLiked = this._threadReactionData.userLiked.has(ev.id);
            const userReposted = this._threadReactionData.userReposted.has(ev.id);

            const session = SessionManager.getSession();

            let composerHtml = '';
            if (session) {
                composerHtml = `
                    <div class="reply-composer">
                        <div class="reply-composer-inner">
                            <div class="reply-composer-avatar" id="reply-avatar">
                                <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                    <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/>
                                </svg>
                            </div>
                            <div class="reply-composer-body">
                                <textarea id="reply-text" placeholder="Post your reply..." maxlength="1000"></textarea>
                                <div class="reply-composer-footer">
                                    <button class="reply-btn-submit" id="reply-submit-btn" disabled onclick="submitReply()">Reply</button>
                                </div>
                            </div>
                        </div>
                    </div>`;
            } else {
                composerHtml = `
                    <div class="reply-login">
                        <a href="/login.html?return=${encodeURIComponent(window.location.href)}">Log in</a> to reply
                    </div>`;
            }

            let repliesHtml = '';
            if (this._threadReplies.length > 0) {
                repliesHtml = `
                    <div class="replies-header">${this._threadReplies.length} ${this._threadReplies.length === 1 ? 'Reply' : 'Replies'}</div>
                    ${this._threadReplies.map(reply => this._renderReply(reply)).join('')}`;
            } else {
                repliesHtml = `<div class="replies-empty">No replies yet. Be the first to reply!</div>`;
            }

            document.getElementById('thread-content').innerHTML = `
                <div class="root-post" data-note-id="${ev.id}">
                    <div class="root-post-header">
                        <div class="root-avatar">
                            ${npub ? `<a href="/user.html?npub=${npub}">` : ''}
                            ${profile.picture
                                ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                : initial
                            }
                            ${npub ? '</a>' : ''}
                        </div>
                        <div class="root-author-info">
                            <div class="root-display-name">${npub ? `<a href="/user.html?npub=${npub}">${escapeHtml(name)}</a>` : escapeHtml(name)} ${!NostrSocial.isEqualiiserEvent(ev) ? '<span class="feed-nostr-badge">via NOSTR</span>' : ''}</div>
                            <div class="root-handle">${npub ? npub.substring(0, 20) + '...' : ''}</div>
                        </div>
                    </div>
                    <div class="root-content">${content}</div>
                    ${NostrSocial.generateLinkPreviews(ev.content)}
                    ${NostrSocial.generateReleaseAnnouncementCard(ev)}
                    <div class="root-time">${timeStr}</div>
                    <div class="root-stats">
                        <span class="root-stat"><strong class="reply-count-display">${this._threadReplies.length}</strong> ${this._threadReplies.length === 1 ? 'Reply' : 'Replies'}</span>
                        <span class="root-stat"><strong class="like-count-display">${likeCount}</strong> ${likeCount === 1 ? 'Like' : 'Likes'}</span>
                        <span class="root-stat"><strong class="repost-count-display">${repostCount}</strong> ${repostCount === 1 ? 'Repost' : 'Reposts'}</span>
                    </div>
                    <div class="root-actions">
                        <div class="root-action like-btn${userLiked ? ' liked' : ''}" onclick="handleLike('${ev.id}', '${ev.pubkey}')">
                            <svg viewBox="0 0 20 20" fill="${userLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">
                                <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/>
                            </svg>
                        </div>
                        <div class="root-action repost-btn${userReposted ? ' reposted' : ''}" onclick="handleRepost('${ev.id}', '${ev.pubkey}')">
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M7 16V4m0 0L3 8m4-4l4 4M13 4v12m0 0l4-4m-4 4l-4-4"/>
                            </svg>
                        </div>
                    </div>
                </div>
                ${composerHtml}
                ${repliesHtml}`;

            if (session) {
                this._setupReplyComposer();
                this._loadComposerAvatar(session.publicKey);
            }
        },

        _renderReply(reply) {
            const escapeHtml = NostrSocial.escapeHtml;
            const profile = this._threadProfiles.get(reply.pubkey) || {};
            const name = profile.name || 'Nostr User';
            const initial = name.charAt(0).toUpperCase();
            const time = NostrSocial.relativeTime(reply.created_at);
            const content = NostrSocial.linkifyContent(escapeHtml(reply.content));
            const likeCount = this._threadReactionData.likes[reply.id] || 0;
            const userLiked = this._threadReactionData.userLiked.has(reply.id);

            let npub = '';
            try { npub = window.NostrTools.nip19.npubEncode(reply.pubkey); } catch (e) {}

            return `
                <div class="reply-item" data-note-id="${reply.id}">
                    <div class="reply-inner">
                        <div class="reply-avatar">
                            ${npub ? `<a href="/user.html?npub=${npub}">` : ''}
                            ${profile.picture
                                ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                : initial
                            }
                            ${npub ? '</a>' : ''}
                        </div>
                        <div class="reply-body">
                            <div class="reply-header">
                                <span class="reply-name">${npub ? `<a href="/user.html?npub=${npub}">${escapeHtml(name)}</a>` : escapeHtml(name)}</span>
                                ${!NostrSocial.isEqualiiserEvent(reply) ? '<span class="feed-nostr-badge">via NOSTR</span>' : ''}
                                <span class="reply-handle">${npub ? npub.substring(0, 16) + '...' : ''}</span>
                                <span class="reply-time">${time}</span>
                            </div>
                            <div class="reply-content">${content}</div>
                            ${NostrSocial.generateLinkPreviews(reply.content)}
                            ${NostrSocial.generateReleaseAnnouncementCard(reply)}
                            <div class="reply-actions">
                                <div class="reply-action like-btn${userLiked ? ' liked' : ''}" onclick="handleLike('${reply.id}', '${reply.pubkey}')">
                                    <svg viewBox="0 0 20 20" fill="${userLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">
                                        <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/>
                                    </svg>
                                    <span>${likeCount || ''}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>`;
        },

        // ===== Reply Composer =====

        _setupReplyComposer() {
            const textarea = document.getElementById('reply-text');
            const submitBtn = document.getElementById('reply-submit-btn');
            if (!textarea || !submitBtn) return;

            textarea.addEventListener('input', () => {
                submitBtn.disabled = textarea.value.trim().length === 0 || this._isReplying;
            });

            textarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (!submitBtn.disabled) this._submitReply();
                }
            });
        },

        async _loadComposerAvatar(pubkey) {
            const profiles = await NostrSocial.fetchProfiles([pubkey]);
            const p = profiles.get(pubkey);
            const el = document.getElementById('reply-avatar');
            if (!el) return;
            if (p && p.picture) {
                el.innerHTML = `<img src="${NostrSocial.escapeHtml(p.picture)}" alt="" onerror="this.style.display='none'">`;
            } else if (p && p.name) {
                const initials = p.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
                el.textContent = initials;
            }
        },

        async _submitReply() {
            const textarea = document.getElementById('reply-text');
            const submitBtn = document.getElementById('reply-submit-btn');
            const content = textarea?.value?.trim();
            if (!content || this._isReplying) return;

            const session = SessionManager.getSession();
            if (!session) return;

            this._isReplying = true;
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting...'; }

            try {
                const tags = [
                    ['app', 'Equaliser'],
                    ['content-type', 'post'],
                    ['e', this._rootEventId, '', 'root'],
                    ['p', this._rootAuthorPubkey]
                ];

                const event = {
                    kind: 1,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: tags,
                    content: content
                };

                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._threadReplies.push(signedEvent);
                if (!this._threadProfiles.has(signedEvent.pubkey)) {
                    const profiles = await NostrSocial.fetchProfiles([signedEvent.pubkey]);
                    profiles.forEach((v, k) => this._threadProfiles.set(k, v));
                }

                if (textarea) textarea.value = '';
                this._renderThread();
            } catch (error) {
                console.error('Reply failed:', error);
                alert('Failed to post reply. Please try again.');
            } finally {
                this._isReplying = false;
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Reply'; }
            }
        },

        // ===== Reactions =====

        async _loadReactions(noteIds) {
            if (noteIds.length === 0) return;
            this._threadReactionData = await NostrSocial.fetchReactions(noteIds);
            this._renderThread();
        },

        async _handleLike(noteId, authorPubkey) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }
            if (this._threadReactionData.userLiked.has(noteId)) return;

            try {
                const event = {
                    kind: 7,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['e', noteId], ['p', authorPubkey]],
                    content: '+'
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._threadReactionData.likes[noteId] = (this._threadReactionData.likes[noteId] || 0) + 1;
                this._threadReactionData.userLiked.add(noteId);
                this._renderThread();
            } catch (error) {
                console.error('Like failed:', error);
            }
        },

        async _handleRepost(noteId, authorPubkey) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }
            if (this._threadReactionData.userReposted.has(noteId)) return;

            try {
                const event = {
                    kind: 6,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['app', 'Equaliser'], ['e', noteId, NostrSocial.DEFAULT_RELAYS[0]], ['p', authorPubkey]],
                    content: ''
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._threadReactionData.reposts[noteId] = (this._threadReactionData.reposts[noteId] || 0) + 1;
                this._threadReactionData.userReposted.add(noteId);
                this._renderThread();
            } catch (error) {
                console.error('Repost failed:', error);
            }
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.thread = ThreadPage;
})();
