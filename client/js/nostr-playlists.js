/**
 * NostrPlaylists — Playlist CRUD, following, and sharing for Equaliser.
 *
 * Uses Kind 30001 (NIP-51) parameterized replaceable events.
 * Public playlists store track IDs in `e` tags.
 * Private playlists encrypt track IDs in `content` via NIP-04 to self.
 *
 * Depends on: NostrSocial (nostr-social.js), NostrDM (nostr-dm.js), SessionManager (session.js)
 */
const NostrPlaylists = (() => {

    // ===== Cache =====

    const _trackCache = new Map();          // eventId → trackObj (no expiry — Kind 30050 is immutable)
    const _playlistCache = new Map();       // "pubkey:dTag" → {data, ts}
    let _myPlaylistsCache = null;           // {data: [], ts}
    const PLAYLIST_CACHE_TTL = 60 * 1000;   // 60 seconds

    function _isFresh(entry) {
        return entry && (Date.now() - entry.ts) < PLAYLIST_CACHE_TTL;
    }

    // ===== Helpers =====

    function _getTag(event, tagName) {
        const tag = event.tags?.find(t => t[0] === tagName);
        return tag ? tag[1] : null;
    }

    function _isEqualiiserPlaylist(event) {
        return event.kind === 30001 &&
            event.tags?.some(t => t[0] === 'app' && t[1] === 'Equaliser') &&
            _getTag(event, 'd')?.startsWith('playlist-');
    }

    function _isFollowedPlaylistsEvent(event) {
        return event.kind === 30001 &&
            event.tags?.some(t => t[0] === 'app' && t[1] === 'Equaliser') &&
            _getTag(event, 'd') === 'eq:followed-playlists';
    }

    function _parsePlaylistEvent(event) {
        const dTag = _getTag(event, 'd');
        const title = _getTag(event, 'title') || 'Untitled';
        const description = _getTag(event, 'description') || '';
        const visibility = _getTag(event, 'visibility') || 'public';
        const image = _getTag(event, 'image') || '';
        const trackIds = event.tags.filter(t => t[0] === 'e').map(t => t[1]);
        return {
            dTag,
            title,
            description,
            visibility,
            image,
            trackIds,
            pubkey: event.pubkey,
            createdAt: event.created_at,
            rawEvent: event
        };
    }

    // ===== CRUD =====

    async function createPlaylist(title, trackEventIds = [], options = {}) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        const dTag = `playlist-${Date.now()}`;
        const visibility = options.visibility || 'public';
        const tags = [
            ['d', dTag],
            ['title', title]
        ];

        if (options.description) tags.push(['description', options.description]);
        if (options.image) tags.push(['image', options.image]);
        tags.push(['visibility', visibility]);

        let content = '';
        if (visibility === 'private' && trackEventIds.length > 0) {
            content = await _encryptTrackList(trackEventIds);
        } else {
            trackEventIds.forEach(id => tags.push(['e', id]));
        }

        const event = {
            kind: 30001,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        _myPlaylistsCache = null;
        _cachedPlaylists = null;
        return { dTag, event: signedEvent };
    }

    async function updatePlaylist(dTag, title, trackEventIds, options = {}) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        const visibility = options.visibility || 'public';
        const tags = [
            ['d', dTag],
            ['title', title]
        ];

        if (options.description !== undefined) tags.push(['description', options.description]);
        if (options.image) tags.push(['image', options.image]);
        tags.push(['visibility', visibility]);

        let content = '';
        if (visibility === 'private' && trackEventIds.length > 0) {
            content = await _encryptTrackList(trackEventIds);
        } else {
            trackEventIds.forEach(id => tags.push(['e', id]));
        }

        const event = {
            kind: 30001,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        _myPlaylistsCache = null;
        _cachedPlaylists = null;
        _playlistCache.delete(`${session.publicKey}:${dTag}`);
        return signedEvent;
    }

    async function deletePlaylist(dTag) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        // Publish a Kind 5 deletion event referencing the playlist by a-tag
        const event = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['a', `30001:${session.publicKey}:${dTag}`]
            ],
            content: 'Playlist deleted'
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        _myPlaylistsCache = null;
        _cachedPlaylists = null;
        _playlistCache.delete(`${session.publicKey}:${dTag}`);
        return signedEvent;
    }

    // ===== Queries =====

    async function fetchMyPlaylists() {
        const session = SessionManager.getSession();
        if (!session) return [];

        if (_isFresh(_myPlaylistsCache)) return _myPlaylistsCache.data;

        const events = await NostrSocial.fetchNotes({
            kinds: [30001],
            authors: [session.publicKey],
            limit: 200
        });

        // Filter for Equaliser playlists (client-side, relay can't filter multi-char tags)
        const playlists = events.filter(_isEqualiiserPlaylist);

        // Deduplicate by d-tag (keep most recent)
        const byDTag = new Map();
        for (const ev of playlists) {
            const d = _getTag(ev, 'd');
            const existing = byDTag.get(d);
            if (!existing || ev.created_at > existing.created_at) {
                byDTag.set(d, ev);
            }
        }

        const result = [];
        for (const ev of byDTag.values()) {
            const parsed = _parsePlaylistEvent(ev);
            // Decrypt private playlists
            if (parsed.visibility === 'private' && ev.content) {
                try {
                    parsed.trackIds = await _decryptTrackList(ev.content);
                } catch (e) {
                    console.warn('Failed to decrypt playlist:', parsed.dTag, e);
                }
            }
            result.push(parsed);
        }

        result.sort((a, b) => b.createdAt - a.createdAt);
        _myPlaylistsCache = { data: result, ts: Date.now() };
        return result;
    }

    async function fetchPlaylist(pubkey, dTag) {
        const cacheKey = `${pubkey}:${dTag}`;
        const cached = _playlistCache.get(cacheKey);
        if (_isFresh(cached)) return cached.data;

        const events = await NostrSocial.fetchNotes({
            kinds: [30001],
            authors: [pubkey],
            '#d': [dTag],
            limit: 5
        });

        // Find the matching playlist
        const matching = events.filter(ev =>
            _isEqualiiserPlaylist(ev) && _getTag(ev, 'd') === dTag
        );

        if (matching.length === 0) return null;

        // Take most recent
        matching.sort((a, b) => b.created_at - a.created_at);
        const ev = matching[0];
        const parsed = _parsePlaylistEvent(ev);

        // Decrypt if private and we own it
        const session = SessionManager.getSession();
        if (parsed.visibility === 'private' && ev.content && session?.publicKey === pubkey) {
            try {
                parsed.trackIds = await _decryptTrackList(ev.content);
            } catch (e) {
                console.warn('Failed to decrypt playlist:', dTag, e);
            }
        }

        _playlistCache.set(cacheKey, { data: parsed, ts: Date.now() });
        return parsed;
    }

    async function fetchPublicPlaylists(pubkey) {
        const events = await NostrSocial.fetchNotes({
            kinds: [30001],
            authors: [pubkey],
            limit: 200
        });

        const playlists = events.filter(ev =>
            _isEqualiiserPlaylist(ev) && _getTag(ev, 'visibility') !== 'private'
        );

        // Deduplicate by d-tag
        const byDTag = new Map();
        for (const ev of playlists) {
            const d = _getTag(ev, 'd');
            const existing = byDTag.get(d);
            if (!existing || ev.created_at > existing.created_at) {
                byDTag.set(d, ev);
            }
        }

        return Array.from(byDTag.values()).map(_parsePlaylistEvent)
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    async function resolveTrackEvents(trackEventIds) {
        if (!trackEventIds || trackEventIds.length === 0) return [];

        // Split into cached hits and uncached misses
        const uncachedIds = trackEventIds.filter(id => !_trackCache.has(id));

        if (uncachedIds.length > 0) {
            const events = await NostrSocial.fetchNotes({
                kinds: [30050],
                ids: uncachedIds,
                limit: uncachedIds.length
            });

            // Parse and cache each track (Kind 30050 is immutable — cache forever)
            for (const ev of events) {
                const track = {
                    eventId: ev.id,
                    pubkey: ev.pubkey,
                    title: _getTag(ev, 'title') || 'Unknown Track',
                    artist: _getTag(ev, 'artist') || '',
                    previewCid: _getTag(ev, 'ipfs_preview_cid') || '',
                    manifestCid: _getTag(ev, 'ipfs_manifest_cid') || '',
                    blossomCoverHash: _getTag(ev, 'blossom_cover_hash') || '',
                    coverArtCid: _getTag(ev, 'cover_art_cid') || '',
                    duration: parseFloat(_getTag(ev, 'duration') || '0'),
                    priceAmount: _getTag(ev, 'price') || '',
                    priceCurrency: _getTag(ev, 'price_currency') || ''
                };
                _trackCache.set(ev.id, track);
            }
        }

        // Return in the order of the original trackEventIds
        return trackEventIds
            .map(id => _trackCache.get(id))
            .filter(Boolean);
    }

    // ===== Privacy =====

    async function _encryptTrackList(trackIds) {
        const session = SessionManager.getSession();
        const privateKey = SessionManager.getPrivateKey();
        const data = JSON.stringify(trackIds.map(id => ({ e: id })));
        return await NostrDM.encrypt(privateKey, session.publicKey, data);
    }

    async function _decryptTrackList(content) {
        const session = SessionManager.getSession();
        const privateKey = SessionManager.getPrivateKey();
        const decrypted = await NostrDM.decrypt(privateKey, session.publicKey, content);
        const parsed = JSON.parse(decrypted);
        return parsed.map(item => item.e);
    }

    // ===== Following =====

    async function fetchFollowedPlaylists() {
        const session = SessionManager.getSession();
        if (!session) return [];

        const events = await NostrSocial.fetchNotes({
            kinds: [30001],
            authors: [session.publicKey],
            '#d': ['eq:followed-playlists'],
            limit: 5
        });

        const ev = events.find(_isFollowedPlaylistsEvent);
        if (!ev) return [];

        return ev.tags
            .filter(t => t[0] === 'a')
            .map(t => {
                const parts = t[1].split(':');
                if (parts.length >= 3 && parts[0] === '30001') {
                    return { pubkey: parts[1], dTag: parts[2] };
                }
                return null;
            })
            .filter(Boolean);
    }

    async function _getFollowedPlaylistsEvent() {
        const session = SessionManager.getSession();
        if (!session) return null;

        const events = await NostrSocial.fetchNotes({
            kinds: [30001],
            authors: [session.publicKey],
            '#d': ['eq:followed-playlists'],
            limit: 5
        });

        return events.find(_isFollowedPlaylistsEvent) || null;
    }

    async function followPlaylist(pubkey, dTag) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        const existingEvent = await _getFollowedPlaylistsEvent();
        const aTags = existingEvent
            ? existingEvent.tags.filter(t => t[0] === 'a')
            : [];

        const newRef = `30001:${pubkey}:${dTag}`;
        if (aTags.some(t => t[1] === newRef)) return; // already following

        aTags.push(['a', newRef]);

        const event = {
            kind: 30001,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', 'eq:followed-playlists'],
                ...aTags
            ],
            content: ''
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        return signedEvent;
    }

    async function unfollowPlaylist(pubkey, dTag) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        const existingEvent = await _getFollowedPlaylistsEvent();
        if (!existingEvent) return;

        const refToRemove = `30001:${pubkey}:${dTag}`;
        const aTags = existingEvent.tags
            .filter(t => t[0] === 'a' && t[1] !== refToRemove);

        const event = {
            kind: 30001,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', 'eq:followed-playlists'],
                ...aTags
            ],
            content: ''
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        return signedEvent;
    }

    // ===== Sharing =====

    async function sharePlaylistToFeed(playlist, message) {
        const session = SessionManager.getSession();
        if (!session) throw new Error('Not logged in');

        let npub = '';
        try { npub = window.NostrTools.nip19.npubEncode(playlist.pubkey); } catch (e) {}

        const defaultMessage = `Check out my playlist "${playlist.title}" - ${playlist.trackIds.length} track${playlist.trackIds.length !== 1 ? 's' : ''}\n\nequaliser:playlist:${npub}/${playlist.dTag}`;

        const event = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['content-type', 'playlist-share'],
                ['a', `30001:${playlist.pubkey}:${playlist.dTag}`]
            ],
            content: message || defaultMessage
        };

        const signedEvent = await SessionManager.signEvent(event);
        await NostrSocial.publishEvent(signedEvent);
        return signedEvent;
    }

    // ===== Playlist Picker UI =====

    let _pickerEl = null;
    let _cachedPlaylists = null;
    let _pickerDismissHandler = null;

    async function showPlaylistPicker(trackEventId, anchorEl) {
        if (!SessionManager.hasSession()) return;

        // Remove existing picker
        dismissPlaylistPicker();

        // Fetch playlists (cache for session)
        if (!_cachedPlaylists) {
            _cachedPlaylists = await fetchMyPlaylists();
        }

        const picker = document.createElement('div');
        picker.className = 'eq-playlist-picker';
        picker.innerHTML = `
            <div class="eq-playlist-picker-header">Add to playlist</div>
            <div class="eq-playlist-picker-list">
                ${_cachedPlaylists.length === 0 ? '<div class="eq-playlist-picker-empty">No playlists yet</div>' : ''}
                ${_cachedPlaylists.map(pl => {
                    const checked = pl.trackIds.includes(trackEventId);
                    return `<label class="eq-playlist-picker-item" data-dtag="${pl.dTag}">
                        <input type="checkbox" ${checked ? 'checked' : ''} data-dtag="${pl.dTag}" data-title="${NostrSocial.escapeHtml(pl.title)}">
                        <span>${NostrSocial.escapeHtml(pl.title)}</span>
                    </label>`;
                }).join('')}
            </div>
            <div class="eq-playlist-picker-create">
                <button class="eq-playlist-picker-create-btn">+ Create new playlist</button>
                <div class="eq-playlist-picker-create-form" style="display:none">
                    <input type="text" class="eq-playlist-picker-create-input" placeholder="Playlist name" maxlength="100">
                    <button class="eq-playlist-picker-create-save">Create</button>
                </div>
            </div>
        `;

        // Position near anchor
        const rect = anchorEl.getBoundingClientRect();
        picker.style.position = 'fixed';
        picker.style.zIndex = '10000';

        // Position above or below depending on space
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow > 250) {
            picker.style.top = `${rect.bottom + 4}px`;
        } else {
            picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        }
        picker.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;

        document.body.appendChild(picker);
        _pickerEl = picker;

        // Handle checkbox changes
        picker.addEventListener('change', async (e) => {
            const cb = e.target;
            if (cb.type !== 'checkbox') return;
            const dTag = cb.dataset.dtag;
            const pl = _cachedPlaylists.find(p => p.dTag === dTag);
            if (!pl) return;

            if (cb.checked) {
                if (!pl.trackIds.includes(trackEventId)) {
                    pl.trackIds.push(trackEventId);
                }
            } else {
                pl.trackIds = pl.trackIds.filter(id => id !== trackEventId);
            }

            await updatePlaylist(dTag, pl.title, pl.trackIds, {
                description: pl.description,
                visibility: pl.visibility,
                image: pl.image
            });
        });

        // Create new playlist button
        const createBtn = picker.querySelector('.eq-playlist-picker-create-btn');
        const createForm = picker.querySelector('.eq-playlist-picker-create-form');
        const createInput = picker.querySelector('.eq-playlist-picker-create-input');
        const createSave = picker.querySelector('.eq-playlist-picker-create-save');

        createBtn.addEventListener('click', () => {
            createBtn.style.display = 'none';
            createForm.style.display = 'flex';
            createInput.focus();
        });

        const doCreate = async () => {
            const name = createInput.value.trim();
            if (!name) return;
            createSave.disabled = true;
            createSave.textContent = '...';
            const { dTag } = await createPlaylist(name, [trackEventId]);
            _cachedPlaylists = null; // invalidate cache
            dismissPlaylistPicker();
        };

        createSave.addEventListener('click', doCreate);
        createInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doCreate();
        });

        // Dismiss on click outside
        _pickerDismissHandler = (e) => {
            if (!picker.contains(e.target) && e.target !== anchorEl) {
                dismissPlaylistPicker();
            }
        };
        setTimeout(() => document.addEventListener('click', _pickerDismissHandler), 0);
    }

    function dismissPlaylistPicker() {
        if (_pickerEl) {
            _pickerEl.remove();
            _pickerEl = null;
        }
        if (_pickerDismissHandler) {
            document.removeEventListener('click', _pickerDismissHandler);
            _pickerDismissHandler = null;
        }
    }

    function invalidateCache() {
        _cachedPlaylists = null;
        _myPlaylistsCache = null;
        _playlistCache.clear();
        // Note: _trackCache is NOT cleared — Kind 30050 events are immutable
    }

    // ===== Expose public API =====

    return {
        createPlaylist,
        updatePlaylist,
        deletePlaylist,
        fetchMyPlaylists,
        fetchPlaylist,
        fetchPublicPlaylists,
        resolveTrackEvents,
        fetchFollowedPlaylists,
        followPlaylist,
        unfollowPlaylist,
        sharePlaylistToFeed,
        showPlaylistPicker,
        dismissPlaylistPicker,
        invalidateCache
    };
})();
