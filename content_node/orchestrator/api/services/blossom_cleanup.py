"""
Blossom orphan blob cleanup.

Periodically scans Blossom's SQLite database for blobs with no owners
and removes them from both the database and disk. This compensates for
Blossom's DELETE endpoint only removing ownership records without
actually deleting files.

Requires the blossom-data volume mounted at /blossom-data in the
orchestrator container.
"""

import os
import asyncio
import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

# Blossom data directory (mounted from blossom-data Docker volume)
BLOSSOM_DATA_DIR = Path(os.getenv("BLOSSOM_DATA_DIR", "/blossom-data"))
BLOSSOM_DB_PATH = BLOSSOM_DATA_DIR / "sqlite.db"
BLOSSOM_BLOBS_DIR = BLOSSOM_DATA_DIR / "blobs"

# Run cleanup every 5 minutes
CLEANUP_INTERVAL = int(os.getenv("BLOSSOM_CLEANUP_INTERVAL", "300"))


def cleanup_orphaned_blobs() -> dict:
    """
    Find and remove blobs with no owners from Blossom's storage.

    Opens Blossom's SQLite DB, finds orphaned blobs (in `blobs` table
    but not in `owners` table), deletes files from disk, and removes
    DB records.

    Returns dict with counts: {removed, errors, skipped}
    """
    if not BLOSSOM_DB_PATH.exists():
        logger.debug("Blossom DB not found, skipping cleanup")
        return {"removed": 0, "errors": 0, "skipped": 0}

    removed = 0
    errors = 0
    skipped = 0

    try:
        conn = sqlite3.connect(str(BLOSSOM_DB_PATH), timeout=5)
        conn.execute("PRAGMA journal_mode=WAL")

        # Find blobs with no owners
        orphans = conn.execute("""
            SELECT b.sha256, b.type
            FROM blobs b
            LEFT JOIN owners o ON b.sha256 = o.blob
            WHERE o.id IS NULL
        """).fetchall()

        if not orphans:
            conn.close()
            return {"removed": 0, "errors": 0, "skipped": 0}

        logger.info(f"Found {len(orphans)} orphaned Blossom blobs")

        for sha256, blob_type in orphans:
            # Find the file on disk (Blossom uses sha256.ext format)
            blob_files = list(BLOSSOM_BLOBS_DIR.glob(f"{sha256}.*"))

            # Delete files from disk
            for blob_file in blob_files:
                try:
                    blob_file.unlink()
                    logger.info(f"Deleted orphan blob file: {blob_file.name}")
                except OSError as e:
                    logger.warning(f"Failed to delete blob file {blob_file.name}: {e}")
                    errors += 1

            # Remove from blobs table
            try:
                conn.execute("DELETE FROM blobs WHERE sha256 = ?", (sha256,))
                # Also clean up accessed table if it exists
                conn.execute("DELETE FROM accessed WHERE blob = ?", (sha256,))
                removed += 1
            except sqlite3.Error as e:
                logger.warning(f"Failed to remove blob record {sha256[:16]}...: {e}")
                errors += 1

        conn.commit()
        conn.close()

        if removed > 0:
            logger.info(f"Blossom cleanup: removed {removed} orphaned blobs, {errors} errors")

    except sqlite3.Error as e:
        logger.warning(f"Blossom cleanup DB error: {e}")
        errors += 1
    except Exception as e:
        logger.warning(f"Blossom cleanup error: {e}")
        errors += 1

    return {"removed": removed, "errors": errors, "skipped": skipped}


async def run_cleanup_loop():
    """
    Background loop that periodically cleans up orphaned Blossom blobs.

    Runs cleanup_orphaned_blobs() in a thread executor to avoid blocking
    the async event loop (SQLite operations are synchronous).
    """
    # Wait for Blossom to start up
    await asyncio.sleep(30)

    logger.info(f"Blossom cleanup loop started (interval: {CLEANUP_INTERVAL}s)")

    while True:
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, cleanup_orphaned_blobs)
            if result["removed"] > 0 or result["errors"] > 0:
                logger.info(f"Blossom cleanup cycle: {result}")
        except Exception as e:
            logger.warning(f"Blossom cleanup loop error: {e}")

        await asyncio.sleep(CLEANUP_INTERVAL)
