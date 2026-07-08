/**
 * Equaliser Persistent Player Module
 *
 * Self-contained music player that injects its own HTML, CSS, and audio element.
 * Persists across page navigations when used inside the app shell (app.html).
 *
 * Usage:
 *   1. Include hls.js before this script
 *   2. Call EqualiserPlayer.init() once on page load
 *   3. Use EqualiserPlayer.setPlaylist(tracks, index) to start playback
 *
 * Track object shape:
 *   { title, artist, previewCid, manifestCid, blossomCoverHash, coverArtCid, duration }
 */

const EqualiserPlayer = {
    _audioEl: null,
    _hlsInstance: null,
    _playlist: [],
    _currentIndex: -1,
    _isPlaying: false,
    _isMuted: false,
    _volume: 1.0,
    _queueOpen: false,
    _initialized: false,

    /**
     * Initialize player - inject HTML, CSS, create audio element, bind events
     */
    init() {
        if (this._initialized) return;
        this._initialized = true;

        this._injectStyles();
        this._injectHTML();
        this._audioEl = document.getElementById('eq-audio-player');
        this._bindEvents();
    },

    /**
     * Set playlist and start playing from the given index
     * @param {Array} tracks - Array of track objects
     * @param {number} startIndex - Index to start playing from
     */
    setPlaylist(tracks, startIndex = 0) {
        this._playlist = tracks;
        this._play(startIndex);
        if (this._queueOpen) this._renderQueue();
    },

    /**
     * Play a single track (sets playlist to just that track)
     * @param {object} track - Track object
     */
    playSingle(track) {
        this.setPlaylist([track], 0);
    },

    /**
     * Pause playback
     */
    pause() {
        if (this._audioEl) this._audioEl.pause();
    },

    /**
     * Resume playback
     */
    resume() {
        if (this._audioEl) this._audioEl.play().catch(e => console.error('Play failed:', e));
    },

    /**
     * Toggle play/pause
     */
    togglePlayPause() {
        if (this._currentIndex === -1) return;
        if (this._isPlaying) {
            this.pause();
        } else {
            this.resume();
        }
    },

    /**
     * Play next track in playlist
     */
    next() {
        if (this._playlist.length === 0) return;
        const nextIndex = (this._currentIndex + 1) % this._playlist.length;
        this._play(nextIndex);
    },

    /**
     * Play previous track (or restart if > 3s in)
     */
    prev() {
        if (this._playlist.length === 0) return;
        if (this._audioEl.currentTime > 3) {
            this._audioEl.currentTime = 0;
            return;
        }
        const prevIndex = this._currentIndex <= 0
            ? this._playlist.length - 1
            : this._currentIndex - 1;
        this._play(prevIndex);
    },

    /**
     * Get current player state
     */
    getState() {
        return {
            track: this._playlist[this._currentIndex] || null,
            trackIndex: this._currentIndex,
            playlist: this._playlist,
            isPlaying: this._isPlaying,
            currentTime: this._audioEl ? this._audioEl.currentTime : 0,
            duration: this._audioEl ? this._audioEl.duration : 0
        };
    },

    /**
     * Check if a track is currently playing (by matching previewCid or manifestCid)
     */
    isTrackPlaying(track) {
        if (this._currentIndex === -1 || !this._isPlaying) return false;
        const current = this._playlist[this._currentIndex];
        if (!current) return false;
        return (track.previewCid && track.previewCid === current.previewCid) ||
               (track.manifestCid && track.manifestCid === current.manifestCid);
    },

    // ===== Internal Methods =====

    _play(index) {
        if (index < 0 || index >= this._playlist.length) return;

        const track = this._playlist[index];
        this._currentIndex = index;

        // Update player bar UI
        const titleEl = document.querySelector('.eq-player-bar .now-playing-title');
        const artistEl = document.querySelector('.eq-player-bar .now-playing-artist');
        const badgeEl = document.getElementById('eq-preview-badge');
        const coverEl = document.querySelector('.eq-player-bar .now-playing-cover');

        if (titleEl) titleEl.textContent = track.title || 'Unknown Track';
        if (artistEl) artistEl.textContent = track.artist || 'Unknown Artist';

        // Only show "Preview" badge when not logged in (playing preview CID)
        const isLoggedIn = typeof SessionManager !== 'undefined' && SessionManager.hasSession();
        if (badgeEl) {
            if (isLoggedIn) {
                badgeEl.classList.remove('visible');
            } else {
                badgeEl.classList.add('visible');
            }
        }

        if (coverEl) {
            const coverUrl = this._getCoverUrl(track.blossomCoverUrl, track.blossomCoverHash, track.coverArtCid);
            if (coverUrl) {
                const fallback = track.coverArtCid && coverUrl !== `/ipfs/${track.coverArtCid}` ? ` data-fallback="/ipfs/${track.coverArtCid}"` : '';
                coverEl.innerHTML = `<img src="${coverUrl}" alt="${this._escapeHtml(track.title || '')}"${fallback} onerror="if(this.dataset.fallback){this.onerror=null;this.src=this.dataset.fallback}else{this.style.display='none'}">`;
            } else {
                coverEl.innerHTML = this._getEqIcon();
            }
        }

        // Play via HLS
        this._playHls(track.previewCid, track.manifestCid);
        this._isPlaying = true;
        this._updatePlayPauseButton();

        // Update queue panel
        this._updateQueueHighlight();

        // Dispatch event for pages to react
        window.dispatchEvent(new CustomEvent('eq-player-track-change', {
            detail: { track, index, playlist: this._playlist }
        }));
    },

    _playHls(previewCid, manifestCid) {
        if (this._hlsInstance) {
            this._hlsInstance.destroy();
            this._hlsInstance = null;
        }

        // Logged-in users get full tracks; guests get 30-second previews
        const isLoggedIn = typeof SessionManager !== 'undefined' && SessionManager.hasSession();
        const cidToPlay = isLoggedIn
            ? (manifestCid || previewCid)
            : (previewCid || manifestCid);
        if (!cidToPlay) {
            console.error('No CID available for playback');
            return;
        }

        const hlsUrl = `/ipfs/${cidToPlay}/playlist.m3u8`;

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            this._hlsInstance = new Hls({
                fragLoadingTimeOut: 20000,
                manifestLoadingTimeOut: 10000,
                levelLoadingTimeOut: 10000
            });
            this._hlsInstance.loadSource(hlsUrl);
            this._hlsInstance.attachMedia(this._audioEl);
            this._hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                this._audioEl.play().catch(e => console.error('Playback failed:', e));
            });
            this._hlsInstance.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.error('Fatal HLS error:', data.type, data.details);
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && previewCid && manifestCid && cidToPlay === previewCid) {
                        console.log('Preview failed, trying full manifest...');
                        this._hlsInstance.loadSource(`/ipfs/${manifestCid}/playlist.m3u8`);
                    }
                }
            });
        } else if (this._audioEl.canPlayType('application/vnd.apple.mpegurl')) {
            this._audioEl.src = hlsUrl;
            this._audioEl.play().catch(e => console.error('Playback failed:', e));
        } else {
            console.error('HLS playback not supported in this browser');
        }
    },

    _updateProgress() {
        const audio = this._audioEl;
        if (audio.duration && !isNaN(audio.duration)) {
            const progress = (audio.currentTime / audio.duration) * 100;
            const fillEl = document.getElementById('eq-progress-fill');
            const currentEl = document.getElementById('eq-time-current');
            const totalEl = document.getElementById('eq-time-total');
            if (fillEl) fillEl.style.width = `${progress}%`;
            if (currentEl) currentEl.textContent = this._formatTime(audio.currentTime);
            if (totalEl) totalEl.textContent = this._formatTime(audio.duration);
        }
    },

    _updatePlayPauseButton() {
        const playBtn = document.getElementById('eq-btn-play');
        if (!playBtn) return;

        if (this._isPlaying) {
            playBtn.innerHTML = `
                <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
                </svg>`;
        } else {
            playBtn.innerHTML = `
                <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/>
                </svg>`;
        }
    },

    _bindEvents() {
        const audio = this._audioEl;

        // Audio element events
        audio.addEventListener('timeupdate', () => this._updateProgress());
        audio.addEventListener('ended', () => this.next());
        audio.addEventListener('pause', () => {
            this._isPlaying = false;
            this._updatePlayPauseButton();
        });
        audio.addEventListener('play', () => {
            this._isPlaying = true;
            this._updatePlayPauseButton();
        });

        // Player control buttons
        document.getElementById('eq-btn-play').addEventListener('click', () => {
            if (this._currentIndex === -1) {
                // Nothing loaded - dispatch event so page can decide what to play
                window.dispatchEvent(new CustomEvent('eq-player-play-requested'));
            } else {
                this.togglePlayPause();
            }
        });

        document.getElementById('eq-btn-prev').addEventListener('click', () => this.prev());
        document.getElementById('eq-btn-next').addEventListener('click', () => this.next());

        // Progress bar seek
        document.getElementById('eq-progress-bar').addEventListener('click', (e) => {
            if (audio.duration) {
                const rect = e.currentTarget.getBoundingClientRect();
                const percent = (e.clientX - rect.left) / rect.width;
                audio.currentTime = percent * audio.duration;
            }
        });

        // Queue button
        document.getElementById('eq-btn-queue').addEventListener('click', () => this._toggleQueue());
        document.getElementById('eq-queue-close').addEventListener('click', () => this._toggleQueue());
        document.getElementById('eq-queue-clear').addEventListener('click', () => this._clearQueue());
        document.getElementById('eq-queue-list').addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.eq-queue-item-remove');
            if (removeBtn) {
                e.stopPropagation();
                this._removeFromQueue(parseInt(removeBtn.dataset.remove, 10));
                return;
            }
            const item = e.target.closest('.eq-queue-item');
            if (item) this._play(parseInt(item.dataset.index, 10));
        });

        // Volume button (mute toggle)
        document.getElementById('eq-btn-volume').addEventListener('click', () => {
            this._isMuted = !this._isMuted;
            audio.muted = this._isMuted;
            this._updateVolumeUI();
        });

        // Volume slider
        document.getElementById('eq-volume-slider').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this._volume = val;
            audio.volume = val;
            this._isMuted = val === 0;
            audio.muted = this._isMuted;
            this._updateVolumeUI();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Don't intercept when typing in inputs/textareas
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.code === 'Space') {
                e.preventDefault();
                if (this._currentIndex === -1) {
                    window.dispatchEvent(new CustomEvent('eq-player-play-requested'));
                } else {
                    this.togglePlayPause();
                }
            }
            if (e.code === 'ArrowRight') this.next();
            if (e.code === 'ArrowLeft') this.prev();
            if (e.code === 'KeyQ') this._toggleQueue();
            if (e.code === 'KeyM') {
                this._isMuted = !this._isMuted;
                audio.muted = this._isMuted;
                this._updateVolumeUI();
            }
        });
    },

    // ===== Helpers =====

    _formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    _getCoverUrl(blossomUrl, blossomHash, ipfsCid) {
        if (blossomUrl) return blossomUrl;
        if (blossomHash) return `/blossom/${blossomHash}`;
        if (ipfsCid) return `/ipfs/${ipfsCid}`;
        return null;
    },

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    _getEqIcon() {
        return `<svg class="eq-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="12" width="3" height="10" rx="1.5" fill="white"/>
            <rect x="7" y="8" width="3" height="16" rx="1.5" fill="white"/>
            <rect x="12" y="4" width="3" height="24" rx="1.5" fill="white"/>
            <rect x="17" y="6" width="3" height="20" rx="1.5" fill="white"/>
            <rect x="22" y="10" width="3" height="14" rx="1.5" fill="white"/>
            <rect x="27" y="13" width="3" height="8" rx="1.5" fill="white"/>
        </svg>`;
    },

    _getVolumeIcon(volume, muted) {
        if (muted || volume === 0) {
            // Muted icon (speaker with X)
            return `<svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217z" clip-rule="evenodd"/>
                <path fill-rule="evenodd" d="M12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>`;
        }
        if (volume < 0.5) {
            // Low volume (speaker with one wave)
            return `<svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217z" clip-rule="evenodd"/>
                <path fill-rule="evenodd" d="M11.828 5.757a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/>
            </svg>`;
        }
        // Full volume (speaker with two waves)
        return `<svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/>
        </svg>`;
    },

    _updateVolumeUI() {
        const btn = document.getElementById('eq-btn-volume');
        const slider = document.getElementById('eq-volume-slider');
        if (btn) btn.innerHTML = this._getVolumeIcon(this._volume, this._isMuted);
        if (slider) slider.value = this._isMuted ? 0 : this._volume;
    },

    // ===== Queue Panel =====

    _toggleQueue() {
        this._queueOpen = !this._queueOpen;
        const panel = document.getElementById('eq-queue-panel');
        const btn = document.getElementById('eq-btn-queue');
        if (panel) panel.classList.toggle('open', this._queueOpen);
        if (btn) btn.classList.toggle('active', this._queueOpen);
        if (this._queueOpen) this._renderQueue();
    },

    _renderQueue() {
        const list = document.getElementById('eq-queue-list');
        if (!list) return;
        if (this._playlist.length === 0) {
            list.innerHTML = '<div class="eq-queue-empty">No tracks in queue</div>';
            return;
        }
        list.innerHTML = this._playlist.map((track, i) => {
            const isCurrent = i === this._currentIndex;
            return `<div class="eq-queue-item${isCurrent ? ' playing' : ''}" data-index="${i}">
                <div class="eq-queue-item-number">${isCurrent ? '<svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/></svg>' : (i + 1)}</div>
                <div class="eq-queue-item-info">
                    <div class="eq-queue-item-title">${this._escapeHtml(track.title || 'Unknown Track')}</div>
                    <div class="eq-queue-item-artist">${this._escapeHtml(track.artist || 'Unknown Artist')}</div>
                </div>
                <button class="eq-queue-item-remove" data-remove="${i}" title="Remove from queue">&times;</button>
            </div>`;
        }).join('');
    },

    _updateQueueHighlight() {
        if (!this._queueOpen) return;
        const items = document.querySelectorAll('.eq-queue-item');
        items.forEach((item, i) => {
            const isCurrent = i === this._currentIndex;
            item.classList.toggle('playing', isCurrent);
            const numEl = item.querySelector('.eq-queue-item-number');
            if (numEl) {
                numEl.innerHTML = isCurrent ? '<svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/></svg>' : (i + 1);
            }
        });
        // Scroll current track into view
        const playing = document.querySelector('.eq-queue-item.playing');
        if (playing) playing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },

    _removeFromQueue(index) {
        if (index < 0 || index >= this._playlist.length) return;
        if (this._playlist.length === 1) {
            this._clearQueue();
            return;
        }
        const wasPlaying = index === this._currentIndex;
        this._playlist.splice(index, 1);
        if (index < this._currentIndex) {
            this._currentIndex--;
        } else if (wasPlaying) {
            // Current track removed — play the track that slid into this position
            if (this._currentIndex >= this._playlist.length) {
                this._currentIndex = 0;
            }
            this._play(this._currentIndex);
        }
        this._renderQueue();
    },

    _clearQueue() {
        if (this._hlsInstance) {
            this._hlsInstance.destroy();
            this._hlsInstance = null;
        }
        if (this._audioEl) {
            this._audioEl.pause();
            this._audioEl.removeAttribute('src');
        }
        this._playlist = [];
        this._currentIndex = -1;
        this._isPlaying = false;
        this._updatePlayPauseButton();
        // Reset player bar UI
        const titleEl = document.querySelector('.eq-player-bar .now-playing-title');
        const artistEl = document.querySelector('.eq-player-bar .now-playing-artist');
        const coverEl = document.querySelector('.eq-player-bar .now-playing-cover');
        const fillEl = document.getElementById('eq-progress-fill');
        const currentEl = document.getElementById('eq-time-current');
        const totalEl = document.getElementById('eq-time-total');
        const badgeEl = document.getElementById('eq-preview-badge');
        if (titleEl) titleEl.textContent = 'Select a track';
        if (artistEl) artistEl.textContent = '-';
        if (coverEl) coverEl.innerHTML = this._getEqIcon();
        if (fillEl) fillEl.style.width = '0%';
        if (currentEl) currentEl.textContent = '0:00';
        if (totalEl) totalEl.textContent = '0:00';
        if (badgeEl) badgeEl.classList.remove('visible');
        this._renderQueue();
    },

    // ===== DOM Injection =====

    _injectHTML() {
        const playerBar = document.createElement('div');
        playerBar.className = 'eq-player-bar';
        playerBar.innerHTML = `
            <div class="now-playing">
                <div class="now-playing-cover">
                    ${this._getEqIcon()}
                </div>
                <div class="now-playing-info">
                    <div class="now-playing-title-row">
                        <div class="now-playing-title">Select a track</div>
                        <span class="preview-badge" id="eq-preview-badge">Preview</span>
                    </div>
                    <div class="now-playing-artist">-</div>
                </div>
            </div>

            <div class="player-controls">
                <div class="control-buttons">
                    <button class="control-btn" id="eq-btn-prev">
                        <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8.445 14.832A1 1 0 0010 14v-2.798l5.445 3.63A1 1 0 0017 14V6a1 1 0 00-1.555-.832L10 8.798V6a1 1 0 00-1.555-.832l-6 4a1 1 0 000 1.664l6 4z"/>
                        </svg>
                    </button>
                    <button class="control-btn play" id="eq-btn-play">
                        <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/>
                        </svg>
                    </button>
                    <button class="control-btn" id="eq-btn-next">
                        <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M4.555 5.168A1 1 0 003 6v8a1 1 0 001.555.832L10 11.202V14a1 1 0 001.555.832l6-4a1 1 0 000-1.664l-6-4A1 1 0 0010 6v2.798l-5.445-3.63z"/>
                        </svg>
                    </button>
                </div>
                <div class="progress-bar">
                    <span class="time" id="eq-time-current">0:00</span>
                    <div class="progress" id="eq-progress-bar">
                        <div class="progress-fill" id="eq-progress-fill"></div>
                    </div>
                    <span class="time" id="eq-time-total">0:00</span>
                </div>
            </div>

            <div class="player-extras">
                <button class="control-btn" id="eq-btn-queue" title="Queue (Q)">
                    <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M2 4a1 1 0 011-1h14a1 1 0 110 2H3a1 1 0 01-1-1zm0 4a1 1 0 011-1h14a1 1 0 110 2H3a1 1 0 01-1-1zm0 4a1 1 0 011-1h10a1 1 0 110 2H3a1 1 0 01-1-1zm12 0a1 1 0 011-1h1a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 01-1-1z" clip-rule="evenodd"/>
                    </svg>
                </button>
                <button class="control-btn" id="eq-btn-volume" title="Mute (M)">
                    ${this._getVolumeIcon(1.0)}
                </button>
                <input type="range" id="eq-volume-slider" class="eq-volume-slider" min="0" max="1" step="0.01" value="1" title="Volume">
            </div>
        `;
        document.body.appendChild(playerBar);

        // Queue panel
        const queuePanel = document.createElement('div');
        queuePanel.className = 'eq-queue-panel';
        queuePanel.id = 'eq-queue-panel';
        queuePanel.innerHTML = `
            <div class="eq-queue-header">
                <span>Queue</span>
                <div class="eq-queue-header-actions">
                    <button class="eq-queue-clear" id="eq-queue-clear">Clear</button>
                    <button class="eq-queue-close" id="eq-queue-close">&times;</button>
                </div>
            </div>
            <div class="eq-queue-list" id="eq-queue-list"></div>
        `;
        document.body.appendChild(queuePanel);

        // Hidden audio element
        const audio = document.createElement('audio');
        audio.id = 'eq-audio-player';
        audio.preload = 'metadata';
        document.body.appendChild(audio);
    },

    _injectStyles() {
        if (document.getElementById('eq-player-styles')) return;

        const link = document.createElement('link');
        link.id = 'eq-player-styles';
        link.rel = 'stylesheet';
        link.href = '/common/css/eq-player.css?v=1';
        document.head.appendChild(link);
    },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = EqualiserPlayer;
}
