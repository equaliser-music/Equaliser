"""
IPFS service for uploading content.

Uploads files and directories to the local IPFS node via the HTTP API.
"""

import os
import logging
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# IPFS API endpoint (internal Docker network)
IPFS_API_URL = os.getenv("IPFS_API_URL", "http://ipfs:5001")


async def upload_file_to_ipfs(file_path: Path, pin: bool = True) -> str:
    """
    Upload a single file to IPFS.

    Args:
        file_path: Path to the file to upload
        pin: Whether to pin the content (default True)

    Returns:
        CID of the uploaded content
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        with open(file_path, "rb") as f:
            files = {"file": (file_path.name, f)}
            params = {"pin": str(pin).lower()}

            response = await client.post(
                f"{IPFS_API_URL}/api/v0/add",
                files=files,
                params=params
            )

            if response.status_code != 200:
                raise RuntimeError(f"IPFS upload failed: {response.text}")

            result = response.json()
            return result["Hash"]


async def upload_directory_to_ipfs(dir_path: Path, pin: bool = True) -> str:
    """
    Upload a directory to IPFS, preserving structure.

    Uses the IPFS add command with wrap-with-directory to create
    a directory structure accessible via a single CID.

    Args:
        dir_path: Path to the directory to upload
        pin: Whether to pin the content (default True)

    Returns:
        CID of the directory (root)
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        # Collect all files in directory
        files = []
        for file_path in dir_path.rglob("*"):
            if file_path.is_file():
                # Relative path within the directory
                rel_path = file_path.relative_to(dir_path)
                with open(file_path, "rb") as f:
                    content = f.read()
                # Use the relative path as the filename for directory structure
                files.append(("file", (str(rel_path), content)))

        params = {
            "pin": str(pin).lower(),
            "wrap-with-directory": "true",
            "cid-version": "1"
        }

        response = await client.post(
            f"{IPFS_API_URL}/api/v0/add",
            files=files,
            params=params
        )

        if response.status_code != 200:
            raise RuntimeError(f"IPFS directory upload failed: {response.text}")

        # Response is newline-delimited JSON, last line is the directory
        lines = response.text.strip().split("\n")
        results = [__import__("json").loads(line) for line in lines]

        # Find the root directory (empty name or last item with Name="")
        for result in reversed(results):
            if result.get("Name") == "":
                return result["Hash"]

        # Fallback to last result
        return results[-1]["Hash"]


async def get_ipfs_cid(content: bytes) -> str:
    """
    Get the CID for content without adding it to IPFS.

    Useful for checking if content already exists.

    Args:
        content: Bytes content to hash

    Returns:
        CID that would be assigned to this content
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{IPFS_API_URL}/api/v0/add",
            files={"file": ("content", content)},
            params={"only-hash": "true"}
        )

        if response.status_code != 200:
            raise RuntimeError(f"IPFS hash failed: {response.text}")

        result = response.json()
        return result["Hash"]


async def pin_cid(cid: str) -> bool:
    """
    Pin a CID to ensure it's not garbage collected.

    Args:
        cid: Content identifier to pin

    Returns:
        True if pinned successfully
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{IPFS_API_URL}/api/v0/pin/add",
            params={"arg": cid}
        )

        return response.status_code == 200


async def unpin_cid(cid: str) -> bool:
    """
    Unpin a CID from IPFS. Content will be garbage collected.

    Args:
        cid: Content identifier to unpin

    Returns:
        True if unpinned successfully
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(
                f"{IPFS_API_URL}/api/v0/pin/rm",
                params={"arg": cid}
            )
            if response.status_code != 200:
                logger.warning(f"IPFS unpin failed for {cid[:16]}: {response.text}")
                return False
            return True
        except httpx.RequestError as e:
            logger.warning(f"IPFS unpin error for {cid[:16]}: {e}")
            return False


async def announce_to_dht(cid: str) -> bool:
    """
    Announce content to the DHT for discovery.

    Helps make content available on public gateways faster.

    Args:
        cid: Content identifier to announce

    Returns:
        True if announced successfully
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{IPFS_API_URL}/api/v0/dht/provide",
            params={"arg": cid}
        )

        return response.status_code == 200
