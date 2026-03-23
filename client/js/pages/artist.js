/**
 * Artist Page Module
 *
 * Artist profile view with discography, feed, and follow system.
 * Extracted from artist.html for use with the app shell router.
 * Includes player integration: clicking tracks calls EqualiserPlayer.setPlaylist().
 */
(function() {
    'use strict';

    const DEFAULT_RELAYS = (typeof NostrSocial !== 'undefined') ? NostrSocial.DEFAULT_RELAYS : [];

    const ArtistPage = {
        _artistProfile: null,
        _artistReleases: [],
        _selectedReleaseIndex: -1,
        _feedNotes: [],
        _reactionData: { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() },
        _isFollowing: false,
        _userContactTags: [],
        _userContactContent: '',
        _currentPubkeyHex: null,
        _currentNpub: null,

        init(params) {
            // Expose global functions for onclick handlers
            window.searchArtist = (e) => this._searchArtist(e);
            window.loadArtist = (npub) => this._loadArtist(npub);
            window.selectRelease = (i) => this._selectRelease(i);
            window.showSearch = () => this._showSearch();
            window.copyNpub = (npub) => this._copyNpub(npub);
            window.toggleFollow = (hex) => this._toggleFollow(hex);
            window.handleLike = (noteId, pubkey) => this._handleLike(noteId, pubkey);
            window.handleRepost = (noteId, pubkey) => this._handleRepost(noteId, pubkey);
            window.isOwnProfile = (hex) => this._isOwnProfile(hex);

            // Check URL for npub parameter
            const npub = params.npub || null;
            if (npub) {
                const inputEl = document.getElementById('npub-input');
                if (inputEl) inputEl.value = npub;
                this._loadArtist(npub);
            }
        },

        cleanup() {
            delete window.searchArtist;
            delete window.loadArtist;
            delete window.selectRelease;
            delete window.showSearch;
            delete window.copyNpub;
            delete window.toggleFollow;
            delete window.handleLike;
            delete window.handleRepost;
            delete window.isOwnProfile;

            this._artistProfile = null;
            this._artistReleases = [];
            this._selectedReleaseIndex = -1;
            this._feedNotes = [];
            this._reactionData = { likes: {}, reposts: {}, userLiked: new Set(), userReposted: new Set() };
            this._isFollowing = false;
            this._userContactTags = [];
            this._userContactContent = '';
            this._currentPubkeyHex = null;
            this._currentNpub = null;
        },

        // ===== Search =====

        _searchArtist(event) {
            event.preventDefault();
            const npub = (document.getElementById('npub-input')?.value || '').trim();
            if (!npub) { alert('Please enter an npub'); return; }

            // Update URL with replaceState
            const url = new URL(window.location);
            url.searchParams.set('npub', npub);
            history.replaceState({}, '', url);

            this._loadArtist(npub);
        },

        // ===== Load Artist =====

        async _loadArtist(npub) {
            const mainContent = document.getElementById('main-content');
            if (!mainContent) return;

            mainContent.innerHTML = `
                <div class="loading">
                    <div class="loading-spinner"></div>
                    <span>Loading artist profile from NOSTR relay...</span>
                </div>`;

            try {
                let pubkeyHex;
                try {
                    const decoded = NostrTools.nip19.decode(npub);
                    if (decoded.type !== 'npub') throw new Error('Invalid npub format');
                    pubkeyHex = decoded.data;
                } catch (e) {
                    throw new Error('Invalid npub format. Expected npub1...');
                }

                const profile = await this._fetchProfile(pubkeyHex);
                if (!profile) throw new Error('Artist not found on relay');

                this._artistProfile = profile;
                this._currentPubkeyHex = pubkeyHex;
                this._currentNpub = npub;
                this._renderArtist(npub, pubkeyHex);

            } catch (error) {
                console.error('Error loading artist:', error);
                mainContent.innerHTML = `
                    <div class="error">
                        <h2 class="error-title">Could not load artist</h2>
                        <p class="error-message">${this._escapeHtml(error.message)}</p>
                        <button class="btn btn-secondary" onclick="showSearch()">Try Again</button>
                    </div>`;
            }
        },

        // ===== Profile Fetching =====

        async _fetchProfile(pubkeyHex) {
            // Try Cache API first (REST — no WebSocket needed)
            if (typeof CacheAPI !== 'undefined') {
                try {
                    const events = await CacheAPI.queryEvents({ kinds: [0], authors: [pubkeyHex], limit: 1 });
                    if (events && events.length > 0) {
                        const profile = JSON.parse(events[0].content);
                        profile._event = events[0];
                        return profile;
                    }
                } catch (e) {}
            }

            // Fallback: WebSocket via NostrSocial
            const events = await NostrSocial.queryRelays({ kinds: [0], authors: [pubkeyHex], limit: 1 });
            if (events && events.length > 0) {
                try {
                    const profile = JSON.parse(events[0].content);
                    profile._event = events[0];
                    return profile;
                } catch (e) {}
            }
            return null;
        },

        // ===== Render Artist =====

        _renderArtist(npub, pubkeyHex) {
            const mainContent = document.getElementById('main-content');
            if (!mainContent) return;

            const profile = this._artistProfile;
            const escapeHtml = this._escapeHtml;

            const initials = (profile.name || 'A').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            const equaliser = profile.equaliser || {};
            const genres = equaliser.genres || [];
            const location = equaliser.location || profile.location || '';
            const joinedDate = equaliser.joinedDate || '';
            const shortNpub = npub.substring(0, 12) + '...' + npub.substring(npub.length - 6);

            mainContent.innerHTML = `
                <!-- Banner -->
                <div class="artist-banner" id="artist-banner">
                    ${profile.banner ? `<img src="${profile.banner}" alt="Artist Banner">` : ''}
                </div>

                <!-- Artist Header -->
                <div class="artist-header">
                    <div class="artist-avatar" id="artist-avatar">
                        ${profile.picture
                            ? `<img src="${profile.picture}" alt="${escapeHtml(profile.name || '')}">`
                            : initials
                        }
                    </div>
                    <div class="artist-info">
                        <h1 class="artist-name">${escapeHtml(profile.name || 'Unknown Artist')}</h1>
                        <div class="artist-meta">
                            ${location ? `
                                <span>
                                    <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20">
                                        <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/>
                                    </svg>
                                    ${escapeHtml(location)}
                                </span>
                            ` : ''}
                            ${genres.map(g => `<span class="genre-tag">${escapeHtml(g)}</span>`).join('')}
                            <span class="npub-tag" onclick="copyNpub('${npub}')" title="Click to copy full npub">${shortNpub}</span>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="artist-actions">
                    ${!this._isOwnProfile(pubkeyHex) ? `
                        <button class="btn btn-primary" id="follow-btn" onclick="toggleFollow('${pubkeyHex}')" disabled>
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6z"/>
                                <path d="M16 7a1 1 0 10-2 0v1h-1a1 1 0 100 2h1v1a1 1 0 102 0v-1h1a1 1 0 100-2h-1V7z"/>
                            </svg>
                            Follow
                        </button>
                    ` : ''}
                    <button class="btn btn-secondary" onclick="copyNpub('${npub}')">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/>
                            <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/>
                        </svg>
                        Copy npub
                    </button>
                    ${profile.lud16 ? `
                        <button class="btn btn-primary" onclick="alert('Lightning address: ${escapeHtml(profile.lud16)}')">
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z"/>
                            </svg>
                            Tip Artist
                        </button>
                    ` : ''}
                    <button class="btn btn-secondary" onclick="showSearch()">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/>
                        </svg>
                        Search Another
                    </button>
                </div>

                <!-- Follow Stats -->
                <div class="artist-follow-stats" id="artist-follow-stats" data-pubkey="${pubkeyHex}">
                    <span class="artist-follow-stat" style="cursor:pointer" onclick="NostrSocial.showFollowListModal(document.getElementById('artist-follow-stats').dataset.pubkey, 'following')"><strong id="artist-following-count">0</strong> Following</span>
                    <span class="artist-follow-stat" style="cursor:pointer" onclick="NostrSocial.showFollowListModal(document.getElementById('artist-follow-stats').dataset.pubkey, 'followers')"><strong id="artist-followers-count">0</strong> Followers</span>
                </div>

                <!-- Two-column body -->
                <div class="artist-body">
                    <div class="artist-body-left">
                        <!-- Discography -->
                        <div class="discography-section">
                            <div class="section-header" style="padding: 0; margin-bottom: 20px;">
                                <h2 class="section-title">Discography</h2>
                            </div>
                            <div id="discography-content">
                                <div class="discography-loading">Loading releases...</div>
                            </div>
                        </div>

                        <!-- Track List (shown when a release is selected) -->
                        <div class="release-tracklist" id="release-tracklist" style="display: none;"></div>

                        <!-- Bio -->
                        ${profile.about ? `
                            <div class="artist-bio">
                                <p class="bio-text">${escapeHtml(profile.about)}</p>
                            </div>
                        ` : ''}

                        <!-- Profile Info -->
                        <div class="info-section">
                            <div class="section-header">
                                <h2 class="section-title">Profile Details</h2>
                            </div>
                            <div class="info-card">
                                <div class="info-row">
                                    <span class="info-label">Public Key (npub)</span>
                                    <span class="info-value">${shortNpub}</span>
                                </div>
                                <div class="info-row">
                                    <span class="info-label">Public Key (hex)</span>
                                    <span class="info-value">${pubkeyHex.substring(0, 16)}...${pubkeyHex.substring(pubkeyHex.length - 8)}</span>
                                </div>
                                ${profile.nip05 ? `
                                    <div class="info-row">
                                        <span class="info-label">NIP-05 Identifier</span>
                                        <span class="info-value">${escapeHtml(profile.nip05)}</span>
                                    </div>
                                ` : ''}
                                ${profile.lud16 ? `
                                    <div class="info-row">
                                        <span class="info-label">Lightning Address</span>
                                        <span class="info-value">${escapeHtml(profile.lud16)}</span>
                                    </div>
                                ` : ''}
                                ${profile.website ? `
                                    <div class="info-row">
                                        <span class="info-label">Website</span>
                                        <span class="info-value"><a href="${escapeHtml(profile.website)}" target="_blank" style="color: #a855f7;">${escapeHtml(profile.website)}</a></span>
                                    </div>
                                ` : ''}
                                ${joinedDate ? `
                                    <div class="info-row">
                                        <span class="info-label">Joined Equaliser</span>
                                        <span class="info-value">${escapeHtml(joinedDate)}</span>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    </div>

                    <!-- Feed -->
                    <div class="artist-body-right">
                        <div class="feed-section">
                            <div class="feed-header">
                                <h3 class="feed-title">Posts</h3>
                            </div>
                            <div id="feed-content">
                                <div class="feed-loading">Loading posts...</div>
                            </div>
                        </div>
                    </div>
                </div>`;

            // Update page title
            document.title = `${profile.name || 'Artist'} - Equaliser`;

            // Check follow status (async)
            if (!this._isOwnProfile(pubkeyHex)) {
                this._checkFollowStatus(pubkeyHex);
            }

            // Load discography, feed, and follow counts in parallel
            this._loadDiscography(pubkeyHex);
            this._loadFeed(pubkeyHex);
            this._loadFollowCounts(pubkeyHex);
        },

        _showSearch() {
            const mainContent = document.getElementById('main-content');
            if (!mainContent) return;

            mainContent.innerHTML = `
                <div class="search-section" id="search-section">
                    <h2 class="search-title">Find Artist</h2>
                    <p class="search-subtitle">Enter an npub to view an artist's profile from the NOSTR relay</p>
                    <form class="search-form" onsubmit="searchArtist(event)">
                        <input type="text" class="search-input" id="npub-input" placeholder="npub1..." value="">
                        <button type="submit" class="btn btn-primary">View Profile</button>
                    </form>
                </div>`;

            // Clear URL parameter
            const url = new URL(window.location);
            url.searchParams.delete('npub');
            history.replaceState({}, '', url);

            document.title = 'Artist - Equaliser';
        },

        async _copyNpub(npub) {
            try {
                await navigator.clipboard.writeText(npub);
                alert('npub copied to clipboard!');
            } catch (err) {
                console.error('Copy failed:', err);
            }
        },

        _escapeHtml(text) {
            return (typeof NostrSocial !== 'undefined') ? NostrSocial.escapeHtml(text) : text;
        },

        // ===== Discography =====

        async _fetchArtistTracks(pubkeyHex) {
            // Try Cache API first (REST)
            if (typeof CacheAPI !== 'undefined') {
                try {
                    const events = await CacheAPI.queryEvents({ kinds: [30050], authors: [pubkeyHex], limit: 500 });
                    if (events) return events;
                } catch (e) {}
            }

            // Fallback: WebSocket via NostrSocial
            const events = await NostrSocial.queryRelays({ kinds: [30050], authors: [pubkeyHex], limit: 500 });
            return events || [];
        },

        _getTagValue(tags, name) {
            const tag = tags.find(t => t[0] === name);
            return tag ? tag[1] : null;
        },

        _parseTrackEvent(event) {
            const g = (name) => this._getTagValue(event.tags, name);
            return {
                eventId: event.id,
                pubkey: event.pubkey,
                createdAt: event.created_at,
                d: g('d') || '',
                title: g('title') || 'Untitled',
                artist: g('artist') || 'Unknown',
                album: g('album') || '',
                releaseType: g('release_type') || 'single',
                genre: g('genre') || '',
                duration: parseInt(g('duration')) || 0,
                previewCid: g('ipfs_preview_cid') || '',
                manifestCid: g('ipfs_manifest_cid') || '',
                priceAmount: g('price') || '',
                priceCurrency: g('price_currency') || 'SAT',
                releaseDate: g('release_date') || '',
                coverArtCid: g('cover_art_cid') || '',
                blossomCoverHash: g('blossom_cover_hash') || '',
                blossomCoverUrl: g('blossom_cover_url') || '',
                trackNumber: parseInt(g('track_number')) || 0
            };
        },

        _groupTracksIntoReleases(trackEvents) {
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
                        blossomCoverUrl: track.blossomCoverUrl,
                        tracks: [],
                        createdAt: track.createdAt,
                        isSingle: !isAlbumOrEp
                    });
                }

                const album = albumMap.get(albumKey);
                album.tracks.push(track);

                if (!album.blossomCoverUrl && track.blossomCoverUrl) album.blossomCoverUrl = track.blossomCoverUrl;
                if (!album.blossomCoverHash && track.blossomCoverHash) album.blossomCoverHash = track.blossomCoverHash;
                if (!album.coverArtCid && track.coverArtCid) album.coverArtCid = track.coverArtCid;
                if (track.createdAt > album.createdAt) album.createdAt = track.createdAt;
            });

            albumMap.forEach(album => {
                album.tracks.sort((a, b) => a.trackNumber - b.trackNumber);
            });

            return Array.from(albumMap.values()).sort((a, b) => b.createdAt - a.createdAt);
        },

        _getCoverUrl(blossomUrl, blossomHash, ipfsCid) {
            if (blossomUrl) return blossomUrl;
            if (blossomHash) return `/blossom/${blossomHash}`;
            if (ipfsCid) return `/ipfs/${ipfsCid}`;
            return null;
        },

        _formatPrice(amount, currency) {
            if (!amount || amount === '0') return '';
            const symbols = { USD: '$', GBP: '\u00a3', EUR: '\u20ac', JPY: '\u00a5', SAT: '' };
            const sym = symbols[currency] || '';
            if (currency === 'SAT') return `${amount} sats`;
            return `${sym}${amount}`;
        },

        _formatDuration(seconds) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        },

        async _loadDiscography(pubkeyHex) {
            const container = document.getElementById('discography-content');
            if (!container) return;

            const allTracks = await this._fetchArtistTracks(pubkeyHex);

            if (allTracks.length === 0) {
                container.innerHTML = `
                    <div class="discography-empty">
                        <svg fill="currentColor" viewBox="0 0 20 20">
                            <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                        </svg>
                        <p>No releases yet</p>
                    </div>`;
                return;
            }

            this._artistReleases = this._groupTracksIntoReleases(allTracks);
            this._renderDiscography();
        },

        _renderDiscography() {
            const escapeHtml = this._escapeHtml;
            const container = document.getElementById('discography-content');
            if (!container) return;

            container.innerHTML = `<div class="discography-grid">
                ${this._artistReleases.map((release, index) => {
                    const coverUrl = this._getCoverUrl(release.blossomCoverUrl, release.blossomCoverHash, release.coverArtCid);
                    const ipfsFallback = release.coverArtCid && coverUrl !== `/ipfs/${release.coverArtCid}` ? ` data-fallback="/ipfs/${release.coverArtCid}"` : '';
                    const trackCount = release.tracks.length;
                    const typeLabel = release.isSingle ? 'Single' : (release.releaseType === 'ep' ? 'EP' : 'Album');
                    const countLabel = release.isSingle ? 'Single' : `${typeLabel} \u00b7 ${trackCount} track${trackCount !== 1 ? 's' : ''}`;
                    const price = release.tracks[0] ? this._formatPrice(release.tracks[0].priceAmount, release.tracks[0].priceCurrency) : '';
                    const year = release.releaseDate ? release.releaseDate.substring(0, 4) : '';

                    return `
                        <div class="release-card" onclick="selectRelease(${index})">
                            <div class="release-cover">
                                ${coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(release.title)}"${ipfsFallback} onerror="if(this.dataset.fallback){this.onerror=null;this.src=this.dataset.fallback}else{this.style.display='none'}">` : ''}
                                <button class="release-play-btn" onclick="event.stopPropagation(); selectRelease(${index})">
                                    <svg width="18" height="18" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
                                    </svg>
                                </button>
                            </div>
                            <div class="release-title">${escapeHtml(release.title)}</div>
                            <div class="release-meta">
                                <span class="release-type">${countLabel}${year ? ` \u00b7 ${year}` : ''}</span>
                                ${price ? `<span class="release-price">${price}</span>` : ''}
                            </div>
                        </div>`;
                }).join('')}
            </div>`;
        },

        _selectRelease(index) {
            const release = this._artistReleases[index];
            if (!release) return;

            const tracklist = document.getElementById('release-tracklist');
            if (!tracklist) return;

            // Toggle off if already selected
            if (this._selectedReleaseIndex === index) {
                this._selectedReleaseIndex = -1;
                tracklist.style.display = 'none';
                return;
            }

            this._selectedReleaseIndex = index;
            const escapeHtml = this._escapeHtml;
            const coverUrl = this._getCoverUrl(release.blossomCoverUrl, release.blossomCoverHash, release.coverArtCid);
            const ipfsFallback = release.coverArtCid && coverUrl !== `/ipfs/${release.coverArtCid}` ? ` data-fallback="/ipfs/${release.coverArtCid}"` : '';
            const totalSeconds = release.tracks.reduce((sum, t) => sum + t.duration, 0);
            const trackCount = release.tracks.length;

            tracklist.innerHTML = `
                <div class="tracklist-header">
                    <div class="tracklist-cover">
                        ${coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(release.title)}"${ipfsFallback} onerror="if(this.dataset.fallback){this.onerror=null;this.src=this.dataset.fallback}else{this.style.display='none'}">` : ''}
                    </div>
                    <div class="tracklist-info">
                        <h3>${escapeHtml(release.title)}</h3>
                        <span>${trackCount} track${trackCount !== 1 ? 's' : ''} \u00b7 ${Math.floor(totalSeconds / 60)} min</span>
                    </div>
                </div>
                <ul class="tracklist-items">
                    ${release.tracks.map((track, i) => {
                        const price = this._formatPrice(track.priceAmount, track.priceCurrency);
                        const hasPreview = !!track.previewCid;
                        const isLoggedIn = SessionManager.hasSession();
                        return `
                            <li class="tracklist-item${hasPreview ? ' playable' : ''}" style="${hasPreview ? 'cursor:pointer' : ''}"
                                ${hasPreview ? `onclick="if(!event.target.closest('.track-add-playlist'))window._playArtistTrack(${index}, ${i})"` : ''}>
                                <span class="tracklist-num">${i + 1}</span>
                                <span class="tracklist-title">${escapeHtml(track.title)}</span>
                                ${price ? `<span class="tracklist-price">${price}</span>` : ''}
                                <span class="tracklist-duration">${track.duration ? this._formatDuration(track.duration) : ''}</span>
                                ${isLoggedIn ? `<button class="track-add-playlist" data-event-id="${track.eventId}" onclick="event.stopPropagation();NostrPlaylists.showPlaylistPicker('${track.eventId}',this)" title="Add to playlist">+</button>` : ''}
                            </li>`;
                    }).join('')}
                </ul>`;
            tracklist.style.display = '';

            // Expose player integration function
            window._playArtistTrack = (releaseIdx, trackIdx) => {
                this._playTrack(releaseIdx, trackIdx);
            };

            tracklist.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },

        // ===== Player Integration =====

        _playTrack(releaseIndex, trackIndex) {
            const release = this._artistReleases[releaseIndex];
            if (!release) return;

            // Build playlist from the release's tracks
            const playlist = release.tracks
                .filter(t => t.previewCid)
                .map(t => ({
                    title: t.title,
                    artist: t.artist || release.artist,
                    previewCid: t.previewCid,
                    manifestCid: t.manifestCid || '',
                    blossomCoverUrl: t.blossomCoverUrl || release.blossomCoverUrl,
                    blossomCoverHash: t.blossomCoverHash || release.blossomCoverHash,
                    coverArtCid: t.coverArtCid || release.coverArtCid,
                    duration: t.duration
                }));

            if (playlist.length === 0) return;

            // Find the correct index in the filtered playlist
            const track = release.tracks[trackIndex];
            let playlistIndex = 0;
            if (track) {
                playlistIndex = playlist.findIndex(p => p.title === track.title && p.previewCid === track.previewCid);
                if (playlistIndex < 0) playlistIndex = 0;
            }

            if (typeof EqualiserPlayer !== 'undefined' && EqualiserPlayer.setPlaylist) {
                EqualiserPlayer.setPlaylist(playlist, playlistIndex);
            }
        },

        // ===== Feed =====

        async _loadFeed(pubkeyHex) {
            const container = document.getElementById('feed-content');
            if (!container) return;

            let allNotes = await NostrSocial.fetchNotes({ kinds: [1], authors: [pubkeyHex], limit: 50 });
            allNotes = allNotes.filter(n => NostrSocial.isTopLevelPost(n));

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
        },

        _renderFeed(notes) {
            const container = document.getElementById('feed-content');
            if (!container) return;

            const escapeHtml = this._escapeHtml;
            const profile = this._artistProfile || {};
            const avatarInitial = (profile.name || 'A').charAt(0).toUpperCase();

            container.innerHTML = `<div class="feed-items">
                ${notes.map(note => {
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
                                        ? `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${avatarInitial}'">`
                                        : avatarInitial
                                    }
                                </div>
                                <span class="feed-author-name">${escapeHtml(profile.name || 'Artist')}</span>
                                ${!NostrSocial.isEqualiiserEvent(note) ? '<span class="feed-nostr-badge">via NOSTR</span>' : ''}
                                <span class="feed-time">${time}</span>
                            </div>
                            <div class="feed-content">${content}</div>
                            ${NostrSocial.generateLinkPreviews(note.content)}
                            ${NostrSocial.generateReleaseAnnouncementCard(note)}
                            ${NostrSocial.generateQuotedPostCard(note)}
                            <div class="feed-actions">
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
                }).join('')}
            </div>`;
        },

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
                    const svg = likeBtn.querySelector('svg');
                    if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
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
                    kind: 7,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', noteId], ['p', authorPubkey]],
                    content: '+'
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._reactionData.likes[noteId] = (this._reactionData.likes[noteId] || 0) + 1;
                this._reactionData.userLiked.add(noteId);
                this._updateReactionUI();
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
            if (this._reactionData.userReposted.has(noteId)) return;

            try {
                const originalNote = this._feedNotes.find(n => n.id === noteId);
                const event = {
                    kind: 6,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', noteId, DEFAULT_RELAYS[0]], ['p', authorPubkey]],
                    content: originalNote ? JSON.stringify(originalNote) : ''
                };
                const signedEvent = await SessionManager.signEvent(event);
                await NostrSocial.publishEvent(signedEvent);

                this._reactionData.reposts[noteId] = (this._reactionData.reposts[noteId] || 0) + 1;
                this._reactionData.userReposted.add(noteId);
                this._updateReactionUI();
            } catch (error) {
                console.error('Repost failed:', error);
            }
        },

        // ===== Follow System =====

        _isOwnProfile(pubkeyHex) {
            const session = SessionManager.getSession();
            return session && session.publicKey === pubkeyHex;
        },

        async _loadFollowCounts(pubkeyHex) {
            try {
                const [followingEvents, followerEvents] = await Promise.all([
                    (typeof CacheAPI !== 'undefined')
                        ? CacheAPI.queryEvents({ kinds: [3], authors: [pubkeyHex], limit: 1 })
                        : NostrSocial.queryRelays({ kinds: [3], authors: [pubkeyHex], limit: 1 }),
                    (typeof CacheAPI !== 'undefined')
                        ? CacheAPI.queryEvents({ kinds: [3], '#p': [pubkeyHex], limit: 500 })
                        : NostrSocial.queryRelays({ kinds: [3], '#p': [pubkeyHex], limit: 500 })
                ]);

                if (followingEvents && followingEvents.length > 0) {
                    const count = followingEvents[0].tags.filter(t => t[0] === 'p').length;
                    const el = document.getElementById('artist-following-count');
                    if (el) el.textContent = count;
                }

                if (followerEvents) {
                    const uniqueFollowers = new Set(followerEvents.map(ev => ev.pubkey));
                    const el = document.getElementById('artist-followers-count');
                    if (el) el.textContent = uniqueFollowers.size;
                }
            } catch (err) {
                console.error('Failed to load follow counts:', err);
            }
        },

        async _checkFollowStatus(artistPubkeyHex) {
            const session = SessionManager.getSession();
            if (!session) {
                const btn = document.getElementById('follow-btn');
                if (btn) btn.disabled = false;
                return;
            }

            try {
                const contactList = await this._fetchContactList(session.publicKey);
                this._userContactTags = contactList.tags;
                this._userContactContent = contactList.content;
                this._isFollowing = this._userContactTags.some(tag => tag[0] === 'p' && tag[1] === artistPubkeyHex);
                this._updateFollowButton();
            } catch (err) {
                console.error('Failed to check follow status:', err);
            }

            const btn = document.getElementById('follow-btn');
            if (btn) btn.disabled = false;
        },

        async _fetchContactList(pubkeyHex) {
            const events = await NostrSocial.fetchNotes({ kinds: [3], authors: [pubkeyHex], limit: 1 });
            if (events.length > 0) {
                return { tags: events[0].tags || [], content: events[0].content || '' };
            }
            return { tags: [], content: '' };
        },

        async _toggleFollow(artistPubkeyHex) {
            const session = SessionManager.getSession();
            if (!session) {
                window.location.href = `/login.html?return=${encodeURIComponent(window.location.href)}`;
                return;
            }

            const btn = document.getElementById('follow-btn');
            if (btn) btn.disabled = true;

            try {
                if (this._isFollowing) {
                    this._userContactTags = this._userContactTags.filter(tag => !(tag[0] === 'p' && tag[1] === artistPubkeyHex));
                } else {
                    this._userContactTags.push(['p', artistPubkeyHex]);
                }

                const event = {
                    kind: 3,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: this._userContactTags,
                    content: this._userContactContent
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
                    btn.innerHTML = `
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8 9a3 3 0 100-6 3 3 0 000 6zM8 11a6 6 0 016 6H2a6 6 0 016-6z"/>
                            <path d="M16 8a1 1 0 01-1 1h-2a1 1 0 110-2h2a1 1 0 011 1z"/>
                        </svg>
                        Unfollow`;
                };
                btn.onmouseleave = () => {
                    btn.innerHTML = `
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                        </svg>
                        Following`;
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
        }
    };

    window.EqualiserPages = window.EqualiserPages || {};
    window.EqualiserPages.artist = ArtistPage;
})();
