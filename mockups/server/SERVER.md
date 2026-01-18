# Equaliser Upload Server

A Node.js backend server that handles music uploads for the Equaliser platform. It processes audio files, generates previews, and creates the folder structure defined in `STRUCTURE.md`.

## Features

- **Audio Upload**: Accepts WAV and MP3 files
- **Automatic Conversion**: Converts WAV files to 320kbps MP3
- **Preview Generation**: Creates 30-second preview clips for each track
- **Metadata Management**: Generates JSON metadata files per STRUCTURE.md spec
- **Image Handling**: Processes album covers, artist avatars, banners, and press photos
- **Folder Structure**: Automatically creates the complete artist directory structure

## Requirements

- Node.js 18+
- FFmpeg (for audio conversion and preview generation)

### Installing FFmpeg (macOS)

```bash
brew install ffmpeg
```

## Quick Start

### Starting the Server

```bash
cd mockups/server
./start.sh
```

The server will start on port 3001. Access:
- **Local**: http://localhost:3001
- **Network**: http://YOUR_IP:3001

### Stopping the Server

```bash
cd mockups/server
./stop.sh
```

## Manual Start (Alternative)

If you prefer not to use the shell scripts:

```bash
cd mockups/server
npm install          # First time only
node server.js       # Runs in foreground
```

## API Endpoints

### Health Check
```
GET /api/health
```
Returns server status.

### Upload Music
```
POST /api/upload
Content-Type: multipart/form-data
```

**Form Fields:**
- `data` (JSON string): Metadata for artist, album, and tracks
- `tracks` (files): Audio files (WAV or MP3)
- `albumCover` (file): Album artwork image
- `avatar` (file): Artist profile picture
- `banner` (file): Artist banner image
- `photos` (files): Press/promotional photos

**Example `data` JSON:**
```json
{
  "artist": {
    "name": "Artist Name",
    "location": "City, Country",
    "genre": "indie",
    "bio": "Artist biography...",
    "lightningAddress": "artist@getalby.com",
    "socialLinks": {
      "twitter": "https://twitter.com/artist",
      "instagram": "https://instagram.com/artist",
      "website": "https://artist.com"
    }
  },
  "album": {
    "title": "Album Title",
    "releaseDate": "2024-01-15",
    "genre": "indie",
    "price": "2100",
    "description": "Album description..."
  },
  "tracks": [
    {
      "title": "Track One",
      "artist": "Artist Name",
      "bpm": "120",
      "key": "Am",
      "genre": "indie",
      "priceSats": 210,
      "previewStart": 60
    }
  ]
}
```

### List Artists
```
GET /api/artists
```
Returns a list of all uploaded artists.

## Output Structure

Uploaded content is saved to `mockups/content/music/artists/` following this structure:

```
{artist-slug}/
├── profile/
│   ├── avatar.jpg
│   ├── banner.jpg
│   └── bio.json
├── tracks/
│   └── {track-slug}/
│       ├── metadata.json
│       ├── preview.mp3      (30-second clip)
│       ├── full.mp3         (320kbps)
│       └── cover.jpg
├── albums/
│   └── {album-slug}/
│       ├── metadata.json
│       ├── cover.jpg
│       └── tracks.json
├── media/
│   └── photos/
└── payments/
    └── lightning-address.json
```

## Static File Serving

The server also serves static files:
- `/` - Files from `web_portal/` directory
- `/content` - Files from `content/` directory

This allows you to access:
- `http://localhost:3001/home.html` - Home page
- `http://localhost:3001/song-uploader.html` - Upload interface

## Temporary Files

During upload, files are temporarily stored in `mockups/server/temp/`. They are automatically deleted after processing (conversion/copying).

## Troubleshooting

### Port Already in Use
If you see `EADDRINUSE` error:
```bash
./stop.sh
./start.sh
```

Or manually kill the process:
```bash
lsof -ti :3001 | xargs kill
```

### FFmpeg Not Found
Ensure FFmpeg is installed and in your PATH:
```bash
which ffmpeg
# Should output: /opt/homebrew/bin/ffmpeg or similar
```

### Large File Uploads
The server accepts files up to 500MB. For larger files, modify `server.js`:
```javascript
limits: { fileSize: 1000 * 1024 * 1024 } // 1GB
```

## Development

To modify the server:

1. Edit `server.js`
2. Stop and restart the server:
   ```bash
   ./stop.sh && ./start.sh
   ```

## Files

| File | Description |
|------|-------------|
| `server.js` | Main server application |
| `package.json` | Node.js dependencies |
| `start.sh` | Start server script |
| `stop.sh` | Stop server script |
| `server.pid` | PID file (created when running) |
| `temp/` | Temporary upload directory |
