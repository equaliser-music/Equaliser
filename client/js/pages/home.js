/**
 * Home Page Module
 *
 * Displays album grid, track list, community feed.
 * Extracted from home.html inline script for use with the app shell router.
 */

(function() {
    'use strict';

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const relayUrl = `${wsProtocol}//${window.location.host}/relay`;

    const HomePage = {
        _allAlbums: [],
        _currentAlbumTracks: [],
        _currentTrackIndex: -1,
        _selectedAlbumIndex: -1,
        _profileCache: new Map(),
        _feedNotes: [],
        _feedReactionData: { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() },
        _currentFeedTab: 'equaliser',
        _feedCache: { following: null, equaliser: null },
        _openWebSockets: [],

        init(params) {
            this._currentFeedTab = SessionManager.hasSession() ? 'following' : 'equaliser';
            this._bindEvents();
            this._loadContent();

            // Listen for player track changes to update the playing indicator
            this._onTrackChange = (e) => this._updatePlayingState(e.detail);
            window.addEventListener('eq-player-track-change', this._onTrackChange);

            // Listen for play requested when nothing is playing
            this._onPlayRequested = () => {
                if (this._allAlbums.length > 0) {
                    this._selectAlbum(0, true);
                }
            };
            window.addEventListener('eq-player-play-requested', this._onPlayRequested);
        },

        cleanup() {
            // Close any open WebSocket connections
            this._openWebSockets.forEach(ws => {
                try { ws.close(); } catch(e) {}
            });
            this._openWebSockets = [];

            // Remove event listeners
            if (this._onTrackChange) {
                window.removeEventListener('eq-player-track-change', this._onTrackChange);
            }
            if (this._onPlayRequested) {
                window.removeEventListener('eq-player-play-requested', this._onPlayRequested);
            }

            // Reset state
            this._allAlbums = [];
            this._currentAlbumTracks = [];
            this._currentTrackIndex = -1;
            this._selectedAlbumIndex = -1;
            this._feedNotes = [];
            this._feedReactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
            this._feedCache = { following: null, equaliser: null };
        },

        // ===== Helpers =====

        _escapeHtml(text) {
            return NostrSocial.escapeHtml(text);
        },

        _formatTime(seconds) {
            if (!seconds || isNaN(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        _formatPrice(amount, currency) {
            if (!amount && amount !== 0) return '';
            if (currency === 'SAT') return `${amount} sats`;
            const symbols = { USD: '$', GBP: '\u00A3', EUR: '\u20AC', JPY: '\u00A5' };
            const symbol = symbols[currency] || '';
            return `${symbol}${amount} ${currency}`;
        },

        _getTagValue(tags, name) {
            const tag = tags.find(t => t[0] === name);
            return tag ? tag[1] : null;
        },

        _getCoverArtUrl(blossomHash, ipfsCid) {
            if (blossomHash) return `/blossom/${blossomHash}`;
            if (ipfsCid) return `/ipfs/${ipfsCid}`;
            return null;
        },

        _renderCoverImg(blossomHash, ipfsCid, altText) {
            const url = this._getCoverArtUrl(blossomHash, ipfsCid);
            if (url) {
                return `<img src="${url}" alt="${this._escapeHtml(altText)}" onerror="this.style.display='none'">`;
            }
            return '';
        },

        _getArtistDisplayName(pubkey, fallbackName) {
            const profile = this._profileCache.get(pubkey);
            if (profile && profile.name) return profile.name;
            return fallbackName || 'Unknown Artist';
        },

        _getArtistLink(pubkey) {
            try {
                const npub = window.NostrTools.nip19.npubEncode(pubkey);
                return `user.html?npub=${npub}`;
            } catch (e) {
                return '#';
            }
        },

        // ===== NOSTR Data Loading =====

        _fetchAllTracks() {
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                this._openWebSockets.push(ws);
                const subId = 'tracks-' + Math.random().toString(36).substring(7);
                const tracks = [];

                const timeout = setTimeout(() => {
                    try { ws.close(); } catch (e) {}
                    resolve(tracks);
                }, 10000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', subId, {
                        kinds: [30050],
                        limit: 500
                    }]));
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg[0] === 'EVENT' && msg[1] === subId) {
                            tracks.push(msg[2]);
                        } else if (msg[0] === 'EOSE') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(tracks);
                        }
                    } catch (e) {
                        console.error('Error parsing track event:', e);
                    }
                };

                ws.onerror = () => {
                    clearTimeout(timeout);
                    resolve(tracks);
                };
            });
        },

        _fetchProfiles(pubkeys) {
            if (pubkeys.length === 0) return Promise.resolve();
            return new Promise((resolve) => {
                const ws = new WebSocket(relayUrl);
                this._openWebSockets.push(ws);
                const subId = 'profiles-' + Math.random().toString(36).substring(7);

                const timeout = setTimeout(() => {
                    try { ws.close(); } catch (e) {}
                    resolve();
                }, 8000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', subId, {
                        kinds: [0],
                        authors: pubkeys,
                        limit: 100
                    }]));
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                            const profile = JSON.parse(msg[2].content);
                            this._profileCache.set(msg[2].pubkey, {
                                name: profile.display_name || profile.name,
                                picture: profile.picture
                            });
                        } else if (msg[0] === 'EOSE') {
                            clearTimeout(timeout);
                            ws.close();
                            resolve();
                        }
                    } catch (e) {}
                };

                ws.onerror = () => {
                    clearTimeout(timeout);
                    resolve();
                };
            });
        },

        // ===== Community Feed =====

        async _loadCommunityFeed(tab) {
            tab = tab || this._currentFeedTab;
            const feedEl = document.getElementById('nostr-feed');
            if (!feedEl) return;

            feedEl.innerHTML = `
                <div class="feed-loading">
                    <div class="loading-spinner"></div>
                    <div>Loading feed...</div>
                </div>
            `;

            let filter;
            let emptyMessage;

            if (tab === 'equaliser') {
                filter = { kinds: [1], limit: 50 };
                emptyMessage = `
                    <p>No posts yet</p>
                    <p class="sub">Community posts will appear here</p>
                `;
            } else {
                const followedPubkeys = await NostrSocial.fetchContactList();
                if (followedPubkeys.length > 0) {
                    filter = { kinds: [1], authors: followedPubkeys, limit: 50 };
                    emptyMessage = `
                        <p>No posts yet</p>
                        <p class="sub">People you follow haven't posted yet</p>
                    `;
                } else {
                    feedEl.innerHTML = `
                        <div class="feed-empty">
                            <svg fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                            </svg>
                            <p>Your feed is empty</p>
                            <p class="sub">Follow some artists to see their posts here</p>
                        </div>
                    `;
                    return;
                }
            }

            let allNotes = await NostrSocial.fetchNotes(filter);
            allNotes = allNotes.filter(n => NostrSocial.isEqualiiserEvent(n) && NostrSocial.isTopLevelPost(n));

            this._feedCache[tab] = allNotes;

            if (allNotes.length === 0) {
                feedEl.innerHTML = `
                    <div class="feed-empty">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clip-rule="evenodd"/>
                        </svg>
                        ${emptyMessage}
                    </div>
                `;
                return;
            }

            this._feedNotes = allNotes;

            const authorPubkeys = [...new Set(allNotes.map(n => n.pubkey))];
            const feedProfiles = await NostrSocial.fetchProfiles(authorPubkeys);

            this._renderCommunityFeed(allNotes, feedProfiles);

            this._feedReactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
            const noteIds = allNotes.map(n => n.id);
            this._loadFeedReactions(noteIds);
            this._loadFeedReplyCounts(noteIds);
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

            document.querySelectorAll('.feed-tab').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tab);
            });

            this._loadCommunityFeed(tab).catch(err => {
                console.error('Failed to load feed:', err);
                const feedEl = document.getElementById('nostr-feed');
                if (feedEl) {
                    feedEl.innerHTML = `
                        <div class="feed-empty">
                            <p>Could not load feed</p>
                            <p class="sub"><a href="#" onclick="EqualiserPages.home._loadCommunityFeed('${tab}'); return false;">Retry</a></p>
                        </div>
                    `;
                }
            });
        },

        _renderCommunityFeed(notes, profiles) {
            const feedEl = document.getElementById('nostr-feed');
            if (!feedEl) return;

            feedEl.innerHTML = notes.map(note => {
                const profile = profiles.get(note.pubkey) || {};
                const name = profile.name || 'Nostr User';
                const initial = name.charAt(0).toUpperCase();
                const time = NostrSocial.relativeTime(note.created_at);
                const content = NostrSocial.linkifyContent(this._escapeHtml(note.content));
                const likeCount = this._feedReactionData.likes[note.id] || 0;
                const repostCount = this._feedReactionData.reposts[note.id] || 0;
                const userLiked = this._feedReactionData.userLiked.has(note.id);
                const userReposted = this._feedReactionData.userReposted.has(note.id);

                let npub = '';
                try { npub = window.NostrTools.nip19.npubEncode(note.pubkey); } catch (e) {}

                return `
                    <div class="nostr-post" data-note-id="${note.id}">
                        <div class="nostr-post-header">
                            <div class="nostr-avatar">
                                ${profile.picture
                                    ? `<img src="${this._escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
                                    : initial
                                }
                            </div>
                            <div class="nostr-user-info">
                                <div class="nostr-username">${npub ? `<a href="user.html?npub=${npub}">${this._escapeHtml(name)}</a>` : this._escapeHtml(name)}</div>
                                <div class="nostr-handle">${npub ? npub.substring(0, 16) + '...' : ''}</div>
                            </div>
                            <div class="nostr-time">${time}</div>
                        </div>
                        <div class="nostr-content" style="cursor:pointer" onclick="Router.navigate('/thread.html?id=${note.id}')">${content}</div>
                        <div class="nostr-actions">
                            <div class="nostr-action reply-btn" onclick="Router.navigate('/thread.html?id=${note.id}')">
                                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z"/>
                                </svg>
                                <span class="reply-count" data-reply-note-id="${note.id}"></span>
                            </div>
                            <div class="nostr-action like-btn${userLiked ? ' liked' : ''}" onclick="EqualiserPages.home._handleFeedLike('${note.id}', '${note.pubkey}')">
                                <svg width="14" height="14" viewBox="0 0 20 20" fill="${userLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">
                                    <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/>
                                </svg>
                                <span class="like-count">${likeCount || ''}</span>
                            </div>
                            <div class="nostr-action repost-btn${userReposted ? ' reposted' : ''}" onclick="EqualiserPages.home._handleFeedRepost('${note.id}', '${note.pubkey}')">
                                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M7 16V4m0 0L3 8m4-4l4 4M13 4v12m0 0l4-4m-4 4l-4-4"/>
                                </svg>
                                <span class="repost-count">${repostCount || ''}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        },

        // ===== Feed Reactions & Interactions =====

        async _loadFeedReactions(noteIds) {
            if (noteIds.length === 0) return;
            this._feedReactionData = await NostrSocial.fetchReactions(noteIds);
            this._updateFeedReactionUI();
        },

        _updateFeedReactionUI() {
            document.querySelectorAll('#nostr-feed .nostr-post').forEach(post => {
                const noteId = post.dataset.noteId;
                if (!noteId) return;

                const likeBtn = post.querySelector('.like-btn');
                const repostBtn = post.querySelector('.repost-btn');

                if (likeBtn) {
                    const count = this._feedReactionData.likes[noteId] || 0;
                    likeBtn.querySelector('.like-count').textContent = count || '';
                    const liked = this._feedReactionData.userLiked.has(noteId);
                    likeBtn.classList.toggle('liked', liked);
                    const svg = likeBtn.querySelector('svg');
                    svg.setAttribute('fill', liked ? 'currentColor' : 'none');
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

        // ===== Album Grouping =====

        _parseTrackEvent(event) {
            return {
                eventId: event.id,
                pubkey: event.pubkey,
                createdAt: event.created_at,
                d: this._getTagValue(event.tags, 'd') || '',
                title: this._getTagValue(event.tags, 'title') || 'Untitled',
                artist: this._getTagValue(event.tags, 'artist') || 'Unknown',
                album: this._getTagValue(event.tags, 'album') || '',
                releaseType: this._getTagValue(event.tags, 'release_type') || 'single',
                genre: this._getTagValue(event.tags, 'genre') || '',
                duration: parseInt(this._getTagValue(event.tags, 'duration')) || 0,
                manifestCid: this._getTagValue(event.tags, 'ipfs_manifest_cid') || '',
                previewCid: this._getTagValue(event.tags, 'ipfs_preview_cid') || '',
                priceAmount: this._getTagValue(event.tags, 'price') || '',
                priceCurrency: this._getTagValue(event.tags, 'price_currency') || 'SAT',
                releaseDate: this._getTagValue(event.tags, 'release_date') || '',
                coverArtCid: this._getTagValue(event.tags, 'cover_art_cid') || '',
                blossomCoverHash: this._getTagValue(event.tags, 'blossom_cover_hash') || '',
                trackNumber: parseInt(this._getTagValue(event.tags, 'track_number')) || 0
            };
        },

        _groupTracksIntoAlbums(trackEvents) {
            const parsed = trackEvents.map(e => this._parseTrackEvent(e));
            const albumMap = new Map();

            parsed.forEach(track => {
                const isAlbumOrEp = track.album && track.releaseType !== 'single';
                const albumKey = isAlbumOrEp
                    ? `${track.pubkey}:${track.album}`
                    : `${track.pubkey}:single:${track.d}`;

                if (!albumMap.has(albumKey)) {
                    albumMap.set(albumKey, {
                        title: isAlbumOrEp ? track.album : track.title,
                        artist: track.artist,
                        pubkey: track.pubkey,
                        releaseType: track.releaseType,
                        genre: track.genre,
                        releaseDate: track.releaseDate,
                        coverArtCid: track.coverArtCid,
                        blossomCoverHash: track.blossomCoverHash,
                        tracks: [],
                        createdAt: track.createdAt,
                        isSingle: !isAlbumOrEp
                    });
                }

                const album = albumMap.get(albumKey);
                album.tracks.push(track);

                if (!album.blossomCoverHash && track.blossomCoverHash) {
                    album.blossomCoverHash = track.blossomCoverHash;
                }
                if (!album.coverArtCid && track.coverArtCid) {
                    album.coverArtCid = track.coverArtCid;
                }
                if (track.createdAt > album.createdAt) {
                    album.createdAt = track.createdAt;
                }
            });

            albumMap.forEach(album => {
                album.tracks.sort((a, b) => a.trackNumber - b.trackNumber);
            });

            return Array.from(albumMap.values())
                .sort((a, b) => b.createdAt - a.createdAt);
        },

        // ===== Rendering =====

        _renderAlbumGrid(albums) {
            const grid = document.getElementById('featured-albums');
            if (!grid) return;

            if (albums.length === 0) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                        </svg>
                        <p>No music available yet</p>
                        <p class="sub">Check back soon or import some content</p>
                    </div>
                `;
                return;
            }

            grid.innerHTML = albums.map((album, index) => {
                const artistName = this._getArtistDisplayName(album.pubkey, album.artist);
                const coverImg = this._renderCoverImg(album.blossomCoverHash, album.coverArtCid, album.title);
                const trackCount = album.tracks.length;
                const price = album.tracks[0] ? this._formatPrice(album.tracks[0].priceAmount, album.tracks[0].priceCurrency) : '';
                const typeLabel = album.isSingle ? 'Single' : `${trackCount} track${trackCount !== 1 ? 's' : ''}`;

                return `
                    <div class="album-card${this._selectedAlbumIndex === index ? ' selected' : ''}" data-album-index="${index}">
                        <div class="album-cover">
                            ${coverImg}
                            <div class="album-play-button">
                                <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
                                </svg>
                            </div>
                        </div>
                        <div class="album-info">
                            <div class="album-title">${this._escapeHtml(album.title)}</div>
                            <a href="${this._getArtistLink(album.pubkey)}" class="album-artist artist-link">${this._escapeHtml(artistName)}</a>
                            <div class="album-meta">
                                <span class="album-tracks-count">${typeLabel}</span>
                                ${price ? `<span class="album-price">${price}</span>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // Add click handlers
            grid.querySelectorAll('.album-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.artist-link')) return;
                    const index = parseInt(card.dataset.albumIndex);
                    const isPlayButton = e.target.closest('.album-play-button');
                    this._selectAlbum(index, isPlayButton);
                });
            });
        },

        // ===== Album Selection & Track List =====

        _selectAlbum(albumIndex, autoPlay) {
            const album = this._allAlbums[albumIndex];
            if (!album) return;

            this._selectedAlbumIndex = albumIndex;

            document.querySelectorAll('.album-card').forEach((card, i) => {
                card.classList.toggle('selected', i === albumIndex);
            });

            this._currentAlbumTracks = album.tracks;

            // Update track list header
            const coverUrl = this._getCoverArtUrl(album.blossomCoverHash, album.coverArtCid);
            const coverEl = document.getElementById('track-list-cover');
            if (coverEl) {
                if (coverUrl) {
                    coverEl.src = coverUrl;
                    coverEl.style.display = '';
                } else {
                    coverEl.style.display = 'none';
                }
            }

            const artistName = this._getArtistDisplayName(album.pubkey, album.artist);
            const titleEl = document.getElementById('track-list-title');
            const artistEl = document.getElementById('track-list-artist');
            const countEl = document.getElementById('track-list-track-count');
            const durEl = document.getElementById('track-list-duration');

            if (titleEl) titleEl.textContent = album.title;
            if (artistEl) artistEl.textContent = artistName;
            if (countEl) countEl.textContent = `${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}`;

            const totalSeconds = album.tracks.reduce((sum, t) => sum + t.duration, 0);
            if (durEl) durEl.textContent = `${Math.floor(totalSeconds / 60)} min`;

            // Render track list
            const trackListEl = document.getElementById('track-list');
            if (trackListEl) {
                // Determine currently playing track from player state
                const playerState = EqualiserPlayer.getState();
                const playingTrack = playerState.track;

                trackListEl.innerHTML = album.tracks.map((track, index) => {
                    const trackCoverImg = this._renderCoverImg(
                        track.blossomCoverHash || album.blossomCoverHash,
                        track.coverArtCid || album.coverArtCid,
                        track.title
                    );
                    const price = this._formatPrice(track.priceAmount, track.priceCurrency);
                    const isPlaying = playingTrack &&
                        ((track.previewCid && track.previewCid === playingTrack.previewCid) ||
                         (track.manifestCid && track.manifestCid === playingTrack.manifestCid));

                    return `
                        <div class="track-list-item${isPlaying ? ' playing' : ''}" data-track-index="${index}">
                            <div class="track-list-number">
                                <span class="track-num-text">${index + 1}</span>
                                <svg class="track-play-icon" width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg>
                            </div>
                            <div class="track-list-item-cover">${trackCoverImg}</div>
                            <div class="track-list-item-info">
                                <div class="track-list-item-title">${this._escapeHtml(track.title)}</div>
                                <div class="track-list-item-artist">${this._escapeHtml(this._getArtistDisplayName(track.pubkey, track.artist))}</div>
                            </div>
                            <div class="track-list-item-duration">${this._formatTime(track.duration)}</div>
                            ${price ? `<div class="track-list-item-price">${price}</div>` : ''}
                            ${SessionManager.hasSession() ? `<button class="track-add-playlist" data-event-id="${track.eventId}" title="Add to playlist">+</button>` : ''}
                        </div>
                    `;
                }).join('');

                // Add click handlers to track items
                trackListEl.querySelectorAll('.track-list-item').forEach(item => {
                    item.addEventListener('click', (e) => {
                        if (e.target.closest('.track-add-playlist')) return;
                        const index = parseInt(item.dataset.trackIndex);
                        this._playTrackFromList(index);
                    });
                });

                // Playlist picker buttons
                trackListEl.querySelectorAll('.track-add-playlist').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        NostrPlaylists.showPlaylistPicker(btn.dataset.eventId, btn);
                    });
                });
            }

            // Show track list container
            const container = document.getElementById('track-list-container');
            if (container) {
                container.classList.add('active');
                container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

            if (autoPlay && album.tracks.length > 0) {
                this._playTrackFromList(0);
            }
        },

        _playTrackFromList(index) {
            if (index < 0 || index >= this._currentAlbumTracks.length) return;

            const track = this._currentAlbumTracks[index];
            this._currentTrackIndex = index;

            // Build track info for the player, including artist display name
            const trackForPlayer = Object.assign({}, track, {
                artist: this._getArtistDisplayName(track.pubkey, track.artist),
                blossomCoverHash: track.blossomCoverHash || this._allAlbums[this._selectedAlbumIndex]?.blossomCoverHash,
                coverArtCid: track.coverArtCid || this._allAlbums[this._selectedAlbumIndex]?.coverArtCid
            });

            // Set the full album as the playlist in the player
            const playlist = this._currentAlbumTracks.map(t => Object.assign({}, t, {
                artist: this._getArtistDisplayName(t.pubkey, t.artist),
                blossomCoverHash: t.blossomCoverHash || this._allAlbums[this._selectedAlbumIndex]?.blossomCoverHash,
                coverArtCid: t.coverArtCid || this._allAlbums[this._selectedAlbumIndex]?.coverArtCid
            }));

            EqualiserPlayer.setPlaylist(playlist, index);
        },

        _updatePlayingState(detail) {
            // Update which track-list-item has the 'playing' class
            document.querySelectorAll('.track-list-item').forEach(item => {
                const index = parseInt(item.dataset.trackIndex);
                const track = this._currentAlbumTracks[index];
                if (!track || !detail.track) {
                    item.classList.remove('playing');
                    return;
                }
                const isPlaying = (track.previewCid && track.previewCid === detail.track.previewCid) ||
                                  (track.manifestCid && track.manifestCid === detail.track.manifestCid);
                item.classList.toggle('playing', isPlaying);
            });
        },

        // ===== Search =====

        _filterAlbums(query) {
            if (!query) {
                this._renderAlbumGrid(this._allAlbums);
                return;
            }
            const q = query.toLowerCase();
            const filtered = this._allAlbums.filter(album =>
                album.title.toLowerCase().includes(q) ||
                album.artist.toLowerCase().includes(q) ||
                this._getArtistDisplayName(album.pubkey, album.artist).toLowerCase().includes(q) ||
                (album.genre && album.genre.toLowerCase().includes(q)) ||
                album.tracks.some(t => t.title.toLowerCase().includes(q))
            );
            this._renderAlbumGrid(filtered);
        },

        // ===== Event Binding =====

        _bindEvents() {
            // Play all button
            const playAllBtn = document.getElementById('play-all-btn');
            if (playAllBtn) {
                playAllBtn.addEventListener('click', () => {
                    if (this._currentAlbumTracks.length > 0) {
                        this._playTrackFromList(0);
                    }
                });
            }

            // Search
            const searchInput = document.getElementById('search-input');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    this._filterAlbums(e.target.value.trim());
                });
            }
        },

        // ===== Content Loading =====

        async _loadContent() {
            try {
                const trackEvents = await this._fetchAllTracks();

                if (trackEvents.length === 0) {
                    const grid = document.getElementById('featured-albums');
                    if (grid) {
                        grid.innerHTML = `
                            <div class="empty-state">
                                <svg fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                                </svg>
                                <p>No music available yet</p>
                                <p class="sub">Import some content to get started</p>
                            </div>
                        `;
                    }
                    return;
                }

                this._allAlbums = this._groupTracksIntoAlbums(trackEvents);

                const uniquePubkeys = [...new Set(trackEvents.map(t => t.pubkey))];
                await this._fetchProfiles(uniquePubkeys);

                this._renderAlbumGrid(this._allAlbums);

                console.log(`Loaded ${trackEvents.length} tracks in ${this._allAlbums.length} albums from ${uniquePubkeys.length} artists`);

            } catch (error) {
                console.error('Failed to load music:', error);
                const grid = document.getElementById('featured-albums');
                if (grid) {
                    grid.innerHTML = `
                        <div class="error-state">
                            <p>Could not connect to relay</p>
                            <button class="retry-btn" onclick="EqualiserPages.home._loadContent()">Retry</button>
                        </div>
                    `;
                }
            }

            // Render feed tabs
            const feedTabsEl = document.getElementById('feed-tabs');
            if (feedTabsEl) {
                if (SessionManager.hasSession()) {
                    feedTabsEl.innerHTML = `
                        <button class="feed-tab active" data-tab="following" onclick="EqualiserPages.home._switchFeedTab('following')">Your Feed</button>
                        <button class="feed-tab" data-tab="equaliser" onclick="EqualiserPages.home._switchFeedTab('equaliser')">Global Feed</button>
                    `;
                } else {
                    feedTabsEl.innerHTML = `
                        <button class="feed-tab active" data-tab="equaliser">Global Feed</button>
                    `;
                }
            }

            // Load community feed
            this._loadCommunityFeed().catch(err => {
                console.error('Failed to load community feed:', err);
                const feedEl = document.getElementById('nostr-feed');
                if (feedEl) {
                    feedEl.innerHTML = `
                        <div class="feed-empty">
                            <p>Could not load feed</p>
                            <p class="sub"><a href="#" onclick="EqualiserPages.home._loadCommunityFeed(); return false;">Retry</a></p>
                        </div>
                    `;
                }
            });
        }
    };

    // Register with the global page registry
    if (!window.EqualiserPages) window.EqualiserPages = {};
    window.EqualiserPages.home = HomePage;
})();
