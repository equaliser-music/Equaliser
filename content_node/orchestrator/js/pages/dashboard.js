/**
 * Dashboard Page Module
 *
 * Home page: recent releases (Kind 30050 + drafts), profile name,
 * track count. Scoped by the selected artist (label "acting as" support).
 */
(function() {
    'use strict';

    // Local relay URL
    const localRelayUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/relay`;
    const localIpfsGateway = `${window.location.origin}/ipfs/`;

    async function loadAll() {
        await Promise.all([loadProfile(), loadReleases()]);
    }

    // Load the profile for the selected artist (label "acting as" Shibuya etc.)
    async function loadProfile() {
        const targetPubkey = SessionManager.getSelectedArtistPubkey();
        if (!targetPubkey) return;

        try {
            const profile = await fetchProfile(targetPubkey);
            if (profile) {
                const name = profile.name || profile.display_name || 'Artist';
                const el = document.getElementById('artist-name-display');
                if (el) el.textContent = name;
                // Don't touch the sidebar — that's "who am I" (always the caller).
            }
        } catch (error) {
            console.error('Failed to load profile:', error);
        }
    }

    // Fetch profile from relay
    async function fetchProfile(pubkeyHex) {
        return new Promise((resolve) => {
            const ws = new WebSocket(localRelayUrl);
            const subId = 'profile-' + Math.random().toString(36).substring(7);
            let profile = null;

            const timeout = setTimeout(() => {
                ws.close();
                resolve(profile);
            }, 5000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [0],
                    authors: [pubkeyHex],
                    limit: 1
                }]));
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg[0] === 'EVENT' && msg[1] === subId) {
                        profile = JSON.parse(msg[2].content);
                    } else if (msg[0] === 'EOSE') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(profile);
                    }
                } catch (e) {
                    console.error('Error parsing profile:', e);
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                resolve(null);
            };
        });
    }

    // Load releases for the selected artist (a label "acting as" Shibuya sees
    // Shibuya's catalogue, not the label's own).
    async function loadReleases() {
        const targetPubkey = SessionManager.getSelectedArtistPubkey();
        if (!targetPubkey) return;

        try {
            const [releasedTracks, drafts] = await Promise.all([
                fetchReleases(targetPubkey),
                fetchDrafts(targetPubkey)
            ]);

            displayReleases(releasedTracks, drafts);
            const totalEl = document.getElementById('total-tracks');
            if (totalEl) totalEl.textContent = releasedTracks.length + drafts.length;
        } catch (error) {
            console.error('Failed to load releases:', error);
            const list = document.getElementById('releases-list');
            if (list) {
                list.innerHTML = `
                    <div class="empty-state">
                        <p>Failed to load releases</p>
                    </div>
                `;
            }
        }
    }

    // Fetch drafts from API
    async function fetchDrafts(pubkeyHex) {
        try {
            const response = await SessionManager.authFetch(`/api/drafts?pubkey=${pubkeyHex}&status=draft`);
            if (!response.ok) return [];
            const data = await response.json();
            return data.drafts || [];
        } catch (error) {
            console.error('Failed to fetch drafts:', error);
            return [];
        }
    }

    // Fetch releases from relay (Kind 30050)
    async function fetchReleases(pubkeyHex) {
        return new Promise((resolve) => {
            const ws = new WebSocket(localRelayUrl);
            const subId = 'releases-' + Math.random().toString(36).substring(7);
            const releases = [];

            const timeout = setTimeout(() => {
                ws.close();
                resolve(releases);
            }, 5000);

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [30050],
                    authors: [pubkeyHex],
                    limit: 10
                }]));
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg[0] === 'EVENT' && msg[1] === subId) {
                        releases.push(msg[2]);
                    } else if (msg[0] === 'EOSE') {
                        clearTimeout(timeout);
                        ws.close();
                        // Sort by created_at descending
                        releases.sort((a, b) => b.created_at - a.created_at);
                        resolve(releases);
                    }
                } catch (e) {
                    console.error('Error parsing release:', e);
                }
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                resolve([]);
            };
        });
    }

    // Group tracks into releases (albums, EPs, singles)
    // Handles both released tracks (from NOSTR) and drafts (from API)
    function groupTracksIntoReleases(releasedTracks, drafts) {
        const groups = {};

        // Process released tracks from NOSTR
        releasedTracks.forEach(track => {
            const releaseType = getTagValue(track.tags, 'release_type') || 'single';
            const album = getTagValue(track.tags, 'album') || '';

            // For singles, each track is its own release
            // For albums/EPs, group by album name
            const groupKey = releaseType === 'single'
                ? `released-single-${getTagValue(track.tags, 'd')}`
                : `released-${releaseType}-${album}`;

            if (!groups[groupKey]) {
                groups[groupKey] = {
                    title: releaseType === 'single' ? getTagValue(track.tags, 'title') : album,
                    releaseType,
                    coverCid: getTagValue(track.tags, 'cover_art_cid'),
                    blossomCoverHash: getTagValue(track.tags, 'blossom_cover_hash'),
                    releaseDate: getTagValue(track.tags, 'release_date'),
                    createdAt: track.created_at,
                    tracks: [],
                    status: 'released'
                };
            }

            groups[groupKey].tracks.push(track);
            // Use the most recent created_at for the group
            if (track.created_at > groups[groupKey].createdAt) {
                groups[groupKey].createdAt = track.created_at;
            }
            // Use cover from any track if not set
            if (!groups[groupKey].coverCid) {
                groups[groupKey].coverCid = getTagValue(track.tags, 'cover_art_cid');
            }
            if (!groups[groupKey].blossomCoverHash) {
                groups[groupKey].blossomCoverHash = getTagValue(track.tags, 'blossom_cover_hash');
            }
        });

        // Process drafts from API
        drafts.forEach(draft => {
            const releaseType = draft.release_type || 'single';
            const album = draft.album || '';

            // For singles, each track is its own release
            // For albums/EPs, group by album name
            const groupKey = releaseType === 'single'
                ? `draft-single-${draft.id}`
                : `draft-${releaseType}-${album}`;

            const createdAtTimestamp = new Date(draft.created_at).getTime() / 1000;

            if (!groups[groupKey]) {
                groups[groupKey] = {
                    title: releaseType === 'single' ? draft.title : album,
                    releaseType,
                    coverCid: draft.cover_art_cid,
                    blossomCoverHash: draft.blossom_cover_hash,
                    releaseDate: draft.release_date,
                    createdAt: createdAtTimestamp,
                    tracks: [],
                    status: 'draft',
                    draftId: draft.id
                };
            }

            groups[groupKey].tracks.push(draft);
            // Use the most recent created_at for the group
            if (createdAtTimestamp > groups[groupKey].createdAt) {
                groups[groupKey].createdAt = createdAtTimestamp;
            }
            // Use cover from any track if not set
            if (!groups[groupKey].coverCid && draft.cover_art_cid) {
                groups[groupKey].coverCid = draft.cover_art_cid;
            }
            if (!groups[groupKey].blossomCoverHash && draft.blossom_cover_hash) {
                groups[groupKey].blossomCoverHash = draft.blossom_cover_hash;
            }
        });

        // Convert to array and sort: drafts first, then by most recent
        return Object.values(groups).sort((a, b) => {
            // Drafts come first
            if (a.status !== b.status) {
                return a.status === 'draft' ? -1 : 1;
            }
            // Then by date (newest first)
            return b.createdAt - a.createdAt;
        });
    }

    // Display releases in the UI
    function displayReleases(releasedTracks, drafts) {
        const container = document.getElementById('releases-list');
        if (!container) return;

        if (releasedTracks.length === 0 && drafts.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg fill="currentColor" viewBox="0 0 20 20">
                        <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                    </svg>
                    <p>No releases yet</p>
                    <a href="upload.html" class="btn btn-primary">Upload Your First Track</a>
                </div>
            `;
            return;
        }

        // Group tracks into releases (handles both released and drafts)
        const releases = groupTracksIntoReleases(releasedTracks, drafts);

        // Show up to 5 recent releases
        const recentReleases = releases.slice(0, 5);
        container.innerHTML = recentReleases.map(release => {
            const title = release.title || 'Untitled';
            const releaseType = release.releaseType;
            const coverCid = release.coverCid;
            const trackCount = release.tracks.length;
            const releaseDate = release.releaseDate;
            const year = releaseDate ? releaseDate.split('-')[0] : new Date(release.createdAt * 1000).getFullYear();
            const isDraft = release.status === 'draft';

            const blossomCoverHash = release.blossomCoverHash;
            const coverUrl = blossomCoverHash
                ? `/blossom/${blossomCoverHash}`
                : coverCid ? `${localIpfsGateway}${coverCid}` : null;
            const coverHtml = coverUrl
                ? `<img src="${coverUrl}" alt="${title}">`
                : `<svg fill="currentColor" viewBox="0 0 20 20">
                    <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                   </svg>`;

            let meta;
            if (releaseType === 'single') {
                meta = `Single · ${year}`;
            } else if (releaseType === 'ep') {
                meta = `EP · ${trackCount} track${trackCount !== 1 ? 's' : ''} · ${year}`;
            } else {
                meta = `Album · ${trackCount} track${trackCount !== 1 ? 's' : ''} · ${year}`;
            }

            // Add draft indicator
            const statusBadge = isDraft
                ? `<span class="eq-draft-badge" style="display: inline-block;">Draft</span>`
                : '';

            // Different stats display for drafts
            const statsHtml = isDraft
                ? `<a href="edit-release.html?draft=true&id=${release.draftId}" class="eq-edit-link">Edit</a>`
                : `<div class="release-plays">-</div><div class="release-plays-label">plays</div>`;

            return `
                <div class="release-item">
                    <div class="release-cover">${coverHtml}</div>
                    <div class="release-info">
                        <div class="release-title">${escapeHtml(title)}${statusBadge}</div>
                        <div class="release-meta">${meta}</div>
                    </div>
                    <div class="release-stats">
                        ${statsHtml}
                    </div>
                </div>
            `;
        }).join('');
    }

    // Helper: Get tag value
    function getTagValue(tags, name) {
        const tag = tags.find(t => t[0] === name);
        return tag ? tag[1] : null;
    }

    // Helper: Escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    const onArtistSwitched = () => { loadAll(); };

    const DashboardPage = {
        async init(params) {
            // Shell has already run SessionManager.init/requireSession,
            // AdminSidebar.init and awaited fetchRole.

            // Operators are infrastructure-only — no personal-artist surface.
            // Redirect them to their home page (hard role separation). Deferred
            // a tick: the router ignores navigate() while a navigation is in flight.
            if (SessionManager.getRole() === 'operator') {
                setTimeout(() => AdminRouter.navigate('node-overview.html'), 0);
                return;
            }

            // Load data scoped by the selected artist
            await loadAll();

            // Refresh when the user switches artists from the sidebar dropdown
            window.addEventListener('equaliser:artist-switched', onArtistSwitched);
        },

        cleanup() {
            window.removeEventListener('equaliser:artist-switched', onArtistSwitched);
        }
    };

    if (!window.EqualiserAdminPages) window.EqualiserAdminPages = {};
    window.EqualiserAdminPages['dashboard'] = DashboardPage;
})();
