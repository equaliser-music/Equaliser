"""
HLS encoding service using FFmpeg.

Encodes audio files into HLS (HTTP Live Streaming) format with:
- Segmented .ts files for streaming
- .m3u8 playlist manifest
- Separate preview stream (first 30 seconds)
"""

import asyncio
import json
from pathlib import Path


async def get_audio_duration(input_path: Path) -> int:
    """
    Get the duration of an audio file in seconds.

    Args:
        input_path: Path to the audio file

    Returns:
        Duration in seconds (rounded)
    """
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        str(input_path)
    ]

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {stderr.decode()}")

    data = json.loads(stdout.decode())
    duration = float(data["format"]["duration"])

    return round(duration)


async def encode_to_hls(
    input_path: Path,
    output_dir: Path,
    preview_dir: Path,
    preview_duration: int = 30,
    segment_duration: int = 6,
    audio_bitrate: str = "128k"
) -> tuple[Path, Path]:
    """
    Encode an audio file to HLS format.

    Creates:
    - Full track in output_dir with all segments
    - Preview (first N seconds) in preview_dir

    Args:
        input_path: Path to source audio file
        output_dir: Directory for full HLS output
        preview_dir: Directory for preview HLS output
        preview_duration: Duration of preview in seconds (default 30)
        segment_duration: Duration of each HLS segment in seconds (default 6)
        audio_bitrate: Audio encoding bitrate (default 128k)

    Returns:
        Tuple of (full_manifest_path, preview_manifest_path)
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    # Encode full track to HLS
    full_manifest = output_dir / "playlist.m3u8"
    full_cmd = [
        "ffmpeg",
        "-i", str(input_path),
        "-c:a", "aac",
        "-b:a", audio_bitrate,
        "-vn",  # No video
        "-hls_time", str(segment_duration),
        "-hls_list_size", "0",  # Keep all segments in playlist
        "-hls_segment_filename", str(output_dir / "segment_%03d.ts"),
        "-f", "hls",
        str(full_manifest)
    ]

    process = await asyncio.create_subprocess_exec(
        *full_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        raise RuntimeError(f"FFmpeg encoding failed: {stderr.decode()}")

    # Encode preview (first N seconds)
    preview_manifest = preview_dir / "playlist.m3u8"
    preview_cmd = [
        "ffmpeg",
        "-i", str(input_path),
        "-t", str(preview_duration),  # Limit to preview duration
        "-c:a", "aac",
        "-b:a", audio_bitrate,
        "-vn",
        "-hls_time", str(segment_duration),
        "-hls_list_size", "0",
        "-hls_segment_filename", str(preview_dir / "segment_%03d.ts"),
        "-f", "hls",
        str(preview_manifest)
    ]

    process = await asyncio.create_subprocess_exec(
        *preview_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        raise RuntimeError(f"FFmpeg preview encoding failed: {stderr.decode()}")

    return full_manifest, preview_manifest
