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
        if (badgeEl) badgeEl.classList.add('visible');

        if (coverEl) {
            const coverUrl = this._getCoverUrl(track.blossomCoverHash, track.coverArtCid);
            if (coverUrl) {
                coverEl.innerHTML = `<img src="${coverUrl}" alt="${this._escapeHtml(track.title || '')}">`;
            } else {
                coverEl.innerHTML = this._getEqIcon();
            }
        }

        // Play via HLS
        this._playHls(track.previewCid, track.manifestCid);
        this._isPlaying = true;
        this._updatePlayPauseButton();

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

        const cidToPlay = previewCid || manifestCid;
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
        });
    },

    // ===== Helpers =====

    _formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    _getCoverUrl(blossomHash, ipfsCid) {
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
                <button class="control-btn">
                    <svg width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/>
                    </svg>
                </button>
            </div>
        `;
        document.body.appendChild(playerBar);

        // Hidden audio element
        const audio = document.createElement('audio');
        audio.id = 'eq-audio-player';
        audio.preload = 'metadata';
        document.body.appendChild(audio);
    },

    _injectStyles() {
        if (document.getElementById('eq-player-styles')) return;

        const style = document.createElement('style');
        style.id = 'eq-player-styles';
        style.textContent = `
            .eq-player-bar {
                position: fixed;
                bottom: 0;
                left: 240px;
                right: 0;
                background: rgba(15, 15, 25, 0.95);
                backdrop-filter: blur(20px);
                border-top: 1px solid rgba(255, 255, 255, 0.05);
                padding: 16px 24px;
                display: flex;
                align-items: center;
                gap: 24px;
                z-index: 100;
            }

            .eq-player-bar .now-playing {
                display: flex;
                align-items: center;
                gap: 16px;
                flex: 1;
                min-width: 0;
            }

            .eq-player-bar .now-playing-cover {
                width: 56px;
                height: 56px;
                background: linear-gradient(135deg, #8b5cf6, #a855f7);
                border-radius: 8px;
                flex-shrink: 0;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .eq-player-bar .now-playing-cover .eq-icon {
                width: 32px;
                height: 32px;
                opacity: 0.6;
            }

            .eq-player-bar .now-playing-cover img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                border-radius: 8px;
            }

            .eq-player-bar .now-playing-info {
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .eq-player-bar .now-playing-title-row {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
            }

            .eq-player-bar .now-playing-title {
                font-size: 14px;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .eq-player-bar .now-playing-artist {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.6);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .eq-player-bar .preview-badge {
                display: none;
                background: rgba(255, 0, 110, 0.9);
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 9px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                flex-shrink: 0;
            }

            .eq-player-bar .preview-badge.visible {
                display: inline-block;
            }

            .eq-player-bar .player-controls {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 8px;
                flex: 2;
            }

            .eq-player-bar .control-buttons {
                display: flex;
                align-items: center;
                gap: 16px;
            }

            .eq-player-bar .control-btn {
                width: 32px;
                height: 32px;
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.8);
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .eq-player-bar .control-btn:hover {
                color: #ffffff;
                transform: scale(1.1);
            }

            .eq-player-bar .control-btn.play {
                width: 40px;
                height: 40px;
                background: #ffffff;
                border-radius: 50%;
                color: #000000;
            }

            .eq-player-bar .progress-bar {
                width: 100%;
                max-width: 500px;
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .eq-player-bar .time {
                font-size: 11px;
                color: rgba(255, 255, 255, 0.5);
                min-width: 40px;
            }

            .eq-player-bar .progress {
                flex: 1;
                height: 4px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
                position: relative;
                cursor: pointer;
            }

            .eq-player-bar .progress-fill {
                position: absolute;
                left: 0;
                top: 0;
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #8b5cf6, #a855f7);
                border-radius: 2px;
            }

            .eq-player-bar .player-extras {
                display: flex;
                align-items: center;
                gap: 16px;
                flex: 1;
                justify-content: flex-end;
            }

            @media (max-width: 768px) {
                .eq-player-bar {
                    left: 64px;
                }
            }
        `;
        document.head.appendChild(style);
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = EqualiserPlayer;
}
