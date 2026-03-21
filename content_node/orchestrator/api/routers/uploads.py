"""
Generic image upload router.

Uploads images to Blossom for profile avatars, banners, and other general use.
"""

import os
import logging
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, UploadFile, HTTPException
from pydantic import BaseModel

from services.blossom import upload_to_blossom, get_blob_url

logger = logging.getLogger(__name__)

router = APIRouter()

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")


class ImageUploadResponse(BaseModel):
    """Response after successful image upload."""
    blossom_hash: str
    blossom_url: str  # Absolute URL if PUBLIC_BASE_URL set, else relative


@router.post("/image", response_model=ImageUploadResponse)
async def upload_image(file: UploadFile = File(...)):
    """
    Upload an image to Blossom.

    Accepts JPEG, PNG, or WebP images. Returns the Blossom hash and URL
    for use in profile metadata (Kind 0 picture/banner fields).

    No authentication required — Blossom auth uses the node's identity keypair.
    """
    valid_types = ["image/jpeg", "image/png", "image/webp"]
    if not file.content_type or file.content_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {file.content_type}. Must be JPEG, PNG, or WebP."
        )

    try:
        content = await file.read()

        ext = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp"
        }.get(file.content_type, ".jpg")

        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        try:
            blossom_hash = await upload_to_blossom(Path(tmp_path))
        except Exception as e:
            os.unlink(tmp_path)
            raise HTTPException(status_code=500, detail=f"Blossom upload failed: {str(e)}")

        os.unlink(tmp_path)

        if not blossom_hash:
            raise HTTPException(status_code=500, detail="Blossom upload returned no hash")

        # Build URL — absolute if PUBLIC_BASE_URL is set (for cross-node display)
        if PUBLIC_BASE_URL:
            blossom_url = f"{PUBLIC_BASE_URL}/blossom/{blossom_hash}"
        else:
            blossom_url = f"/blossom/{blossom_hash}"

        return ImageUploadResponse(
            blossom_hash=blossom_hash,
            blossom_url=blossom_url,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to upload image: {str(e)}")
