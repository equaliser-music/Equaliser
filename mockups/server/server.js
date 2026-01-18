const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = 3001;

// Paths
const CONTENT_PATH = path.join(__dirname, '..', 'content', 'music', 'artists');
const TEMP_PATH = path.join(__dirname, 'temp');
const WEB_PORTAL_PATH = path.join(__dirname, '..', 'web_portal');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_PATH)) {
    fs.mkdirSync(TEMP_PATH, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(WEB_PORTAL_PATH));
app.use('/content', express.static(path.join(__dirname, '..', 'content')));

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, TEMP_PATH);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Helper: Create directory if it doesn't exist
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// Helper: Generate slug from string
function slugify(str) {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
}

// Helper: Convert WAV to MP3 using ffmpeg
async function convertToMp3(inputPath, outputPath) {
    try {
        await execAsync(`ffmpeg -i "${inputPath}" -codec:a libmp3lame -b:a 320k -y "${outputPath}"`);
        return true;
    } catch (error) {
        console.error('FFmpeg conversion error:', error);
        throw error;
    }
}

// Helper: Generate preview MP3 (30 seconds starting at specified time)
async function generatePreview(inputPath, outputPath, startTime = 60, duration = 30) {
    try {
        // Get audio duration first
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`);
        const totalDuration = parseFloat(stdout.trim());

        // Adjust start time if audio is shorter than startTime + duration
        let actualStart = startTime;
        if (totalDuration < startTime + duration) {
            actualStart = Math.max(0, totalDuration - duration);
        }
        if (totalDuration < duration) {
            // If total duration is less than preview duration, use the whole file
            await execAsync(`ffmpeg -i "${inputPath}" -codec:a libmp3lame -b:a 320k -y "${outputPath}"`);
        } else {
            await execAsync(`ffmpeg -i "${inputPath}" -ss ${actualStart} -t ${duration} -codec:a libmp3lame -b:a 320k -y "${outputPath}"`);
        }
        return true;
    } catch (error) {
        console.error('Preview generation error:', error);
        throw error;
    }
}

// Helper: Get audio duration
async function getAudioDuration(filePath) {
    try {
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
        return Math.round(parseFloat(stdout.trim()));
    } catch (error) {
        console.error('Error getting duration:', error);
        return 0;
    }
}

// Helper: Clean up temp files
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('Error cleaning up temp file:', error);
    }
}

// API: Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Equaliser Upload Server is running' });
});

// API: Upload complete album/artist
app.post('/api/upload', upload.fields([
    { name: 'tracks', maxCount: 50 },
    { name: 'albumCover', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
    { name: 'photos', maxCount: 20 }
]), async (req, res) => {
    const tempFiles = [];

    try {
        const data = JSON.parse(req.body.data);
        const { artist, album, tracks: tracksMeta } = data;

        // Create artist slug
        const artistSlug = slugify(artist.name);
        const artistPath = path.join(CONTENT_PATH, artistSlug);

        // Create folder structure
        ensureDir(path.join(artistPath, 'profile'));
        ensureDir(path.join(artistPath, 'tracks'));
        ensureDir(path.join(artistPath, 'albums'));
        ensureDir(path.join(artistPath, 'media', 'photos'));
        ensureDir(path.join(artistPath, 'payments'));

        // Process tracks
        const processedTracks = [];
        const trackFiles = req.files['tracks'] || [];

        for (let i = 0; i < trackFiles.length; i++) {
            const file = trackFiles[i];
            const meta = tracksMeta[i] || {};
            tempFiles.push(file.path);

            const trackTitle = meta.title || file.originalname.replace(/\.(wav|mp3)$/i, '');
            const trackSlug = slugify(trackTitle) + '-' + String(i + 1).padStart(3, '0');
            const trackPath = path.join(artistPath, 'tracks', trackSlug);
            ensureDir(trackPath);

            const isWav = file.originalname.toLowerCase().endsWith('.wav');
            const fullMp3Path = path.join(trackPath, 'full.mp3');
            const previewMp3Path = path.join(trackPath, 'preview.mp3');

            // Convert to MP3 if WAV, otherwise copy
            if (isWav) {
                console.log(`Converting ${file.originalname} to MP3...`);
                await convertToMp3(file.path, fullMp3Path);
            } else {
                fs.copyFileSync(file.path, fullMp3Path);
            }

            // Generate preview
            console.log(`Generating preview for ${trackTitle}...`);
            await generatePreview(fullMp3Path, previewMp3Path, meta.previewStart || 60, 30);

            // Get duration
            const duration = await getAudioDuration(fullMp3Path);

            // Create track metadata
            const trackMetadata = {
                trackId: trackSlug,
                title: trackTitle,
                artist: meta.artist || artist.name,
                albumId: album.title ? slugify(album.title) + '-' + new Date().getFullYear() : null,
                trackNumber: i + 1,
                duration: duration,
                bpm: meta.bpm ? parseInt(meta.bpm) : null,
                key: meta.key || null,
                genre: meta.genre || album.genre || artist.genre,
                priceSats: meta.priceSats || 210,
                releaseDate: album.releaseDate || new Date().toISOString().split('T')[0],
                previewStart: meta.previewStart || 60,
                previewDuration: 30,
                fileFormat: 'mp3',
                bitrate: 320,
                tags: meta.tags || []
            };

            fs.writeFileSync(
                path.join(trackPath, 'metadata.json'),
                JSON.stringify(trackMetadata, null, 2)
            );

            processedTracks.push({
                trackNumber: i + 1,
                trackId: trackSlug,
                title: trackTitle,
                duration: duration
            });

            // Clean up temp file
            cleanupTempFile(file.path);
        }

        // Process album cover and copy to tracks
        if (req.files['albumCover'] && req.files['albumCover'][0]) {
            const coverFile = req.files['albumCover'][0];
            tempFiles.push(coverFile.path);

            // Copy to album folder if album exists
            if (album.title) {
                const albumSlug = slugify(album.title) + '-' + new Date().getFullYear();
                const albumPath = path.join(artistPath, 'albums', albumSlug);
                ensureDir(albumPath);
                fs.copyFileSync(coverFile.path, path.join(albumPath, 'cover.jpg'));

                // Create album metadata
                const albumMetadata = {
                    albumId: albumSlug,
                    title: album.title,
                    artist: artist.name,
                    releaseDate: album.releaseDate || new Date().toISOString().split('T')[0],
                    totalTracks: processedTracks.length,
                    genre: album.genre || artist.genre,
                    description: album.description || '',
                    priceSats: album.price ? parseInt(album.price) : processedTracks.length * 210
                };

                fs.writeFileSync(
                    path.join(albumPath, 'metadata.json'),
                    JSON.stringify(albumMetadata, null, 2)
                );

                // Create tracks.json
                const tracksJson = {
                    tracks: processedTracks.map(t => ({
                        trackNumber: t.trackNumber,
                        trackId: t.trackId
                    }))
                };

                fs.writeFileSync(
                    path.join(albumPath, 'tracks.json'),
                    JSON.stringify(tracksJson, null, 2)
                );
            }

            // Copy cover to each track folder
            for (const track of processedTracks) {
                const trackCoverPath = path.join(artistPath, 'tracks', track.trackId, 'cover.jpg');
                fs.copyFileSync(coverFile.path, trackCoverPath);
            }

            cleanupTempFile(coverFile.path);
        }

        // Process avatar
        if (req.files['avatar'] && req.files['avatar'][0]) {
            const avatarFile = req.files['avatar'][0];
            tempFiles.push(avatarFile.path);
            fs.copyFileSync(avatarFile.path, path.join(artistPath, 'profile', 'avatar.jpg'));
            cleanupTempFile(avatarFile.path);
        }

        // Process banner
        if (req.files['banner'] && req.files['banner'][0]) {
            const bannerFile = req.files['banner'][0];
            tempFiles.push(bannerFile.path);
            fs.copyFileSync(bannerFile.path, path.join(artistPath, 'profile', 'banner.jpg'));
            cleanupTempFile(bannerFile.path);
        }

        // Process press photos
        if (req.files['photos']) {
            for (let i = 0; i < req.files['photos'].length; i++) {
                const photoFile = req.files['photos'][i];
                tempFiles.push(photoFile.path);
                const ext = path.extname(photoFile.originalname) || '.jpg';
                fs.copyFileSync(
                    photoFile.path,
                    path.join(artistPath, 'media', 'photos', `photo-${i + 1}${ext}`)
                );
                cleanupTempFile(photoFile.path);
            }
        }

        // Create bio.json
        const bioData = {
            name: artist.name,
            bio: artist.bio || '',
            genres: [artist.genre].filter(Boolean),
            location: artist.location || '',
            socialLinks: {
                website: artist.socialLinks?.website || '',
                twitter: artist.socialLinks?.twitter || '',
                instagram: artist.socialLinks?.instagram || ''
            },
            joinedDate: new Date().toISOString().split('T')[0]
        };

        fs.writeFileSync(
            path.join(artistPath, 'profile', 'bio.json'),
            JSON.stringify(bioData, null, 2)
        );

        // Create lightning-address.json
        if (artist.lightningAddress) {
            const paymentData = {
                lightningAddress: artist.lightningAddress,
                description: `Support ${artist.name} directly`,
                minSats: 1,
                maxSats: 1000000
            };

            fs.writeFileSync(
                path.join(artistPath, 'payments', 'lightning-address.json'),
                JSON.stringify(paymentData, null, 2)
            );
        }

        res.json({
            success: true,
            message: `Successfully uploaded ${processedTracks.length} tracks for ${artist.name}`,
            artistSlug: artistSlug,
            artistPath: artistPath,
            tracks: processedTracks
        });

    } catch (error) {
        console.error('Upload error:', error);

        // Clean up any temp files on error
        for (const filePath of tempFiles) {
            cleanupTempFile(filePath);
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: List artists
app.get('/api/artists', (req, res) => {
    try {
        if (!fs.existsSync(CONTENT_PATH)) {
            return res.json({ artists: [] });
        }

        const artists = fs.readdirSync(CONTENT_PATH)
            .filter(f => fs.statSync(path.join(CONTENT_PATH, f)).isDirectory())
            .map(slug => {
                const bioPath = path.join(CONTENT_PATH, slug, 'profile', 'bio.json');
                let bio = { name: slug };
                if (fs.existsSync(bioPath)) {
                    bio = JSON.parse(fs.readFileSync(bioPath, 'utf8'));
                }
                return { slug, ...bio };
            });

        res.json({ artists });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: List all albums with tracks
app.get('/api/albums', (req, res) => {
    try {
        if (!fs.existsSync(CONTENT_PATH)) {
            return res.json({ albums: [] });
        }

        const albums = [];

        // Iterate through all artist directories
        const artistDirs = fs.readdirSync(CONTENT_PATH)
            .filter(f => fs.statSync(path.join(CONTENT_PATH, f)).isDirectory());

        for (const artistSlug of artistDirs) {
            const albumsDir = path.join(CONTENT_PATH, artistSlug, 'albums');
            if (!fs.existsSync(albumsDir)) continue;

            const albumDirs = fs.readdirSync(albumsDir)
                .filter(f => fs.statSync(path.join(albumsDir, f)).isDirectory());

            for (const albumSlug of albumDirs) {
                const albumPath = path.join(albumsDir, albumSlug);
                const metadataPath = path.join(albumPath, 'metadata.json');
                const tracksPath = path.join(albumPath, 'tracks.json');
                const coverPath = path.join(albumPath, 'cover.jpg');

                if (!fs.existsSync(metadataPath)) continue;

                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

                // Load track list
                let trackList = [];
                if (fs.existsSync(tracksPath)) {
                    const tracksData = JSON.parse(fs.readFileSync(tracksPath, 'utf8'));
                    trackList = tracksData.tracks || [];
                }

                // Load full track metadata for each track
                const tracksWithMetadata = [];
                for (const trackRef of trackList) {
                    const trackDir = path.join(CONTENT_PATH, artistSlug, 'tracks', trackRef.trackId);
                    const trackMetaPath = path.join(trackDir, 'metadata.json');

                    if (fs.existsSync(trackMetaPath)) {
                        const trackMeta = JSON.parse(fs.readFileSync(trackMetaPath, 'utf8'));
                        tracksWithMetadata.push({
                            ...trackMeta,
                            trackNumber: trackRef.trackNumber,
                            fullPath: `/content/music/artists/${artistSlug}/tracks/${trackRef.trackId}/full.mp3`,
                            previewPath: `/content/music/artists/${artistSlug}/tracks/${trackRef.trackId}/preview.mp3`,
                            coverPath: `/content/music/artists/${artistSlug}/tracks/${trackRef.trackId}/cover.jpg`
                        });
                    }
                }

                albums.push({
                    id: `${albumSlug}-${artistSlug}`,
                    artistSlug,
                    albumSlug,
                    ...metadata,
                    coverPath: fs.existsSync(coverPath)
                        ? `/content/music/artists/${artistSlug}/albums/${albumSlug}/cover.jpg`
                        : null,
                    tracks: tracksWithMetadata
                });
            }
        }

        res.json({ albums });
    } catch (error) {
        console.error('Error fetching albums:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Equaliser Upload Server Running                  ║
╠═══════════════════════════════════════════════════════════╣
║  Local:    http://localhost:${PORT}                          ║
║  Network:  http://192.168.2.33:${PORT}                       ║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /api/health     - Health check                    ║
║    POST /api/upload     - Upload tracks & metadata        ║
║    GET  /api/artists    - List all artists                ║
║                                                           ║
║  Static files served from: web_portal/                    ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
