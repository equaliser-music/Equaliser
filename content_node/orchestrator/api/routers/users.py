"""
User registration router.

Proxies client registration requests to the Equaliser Relay's internal API,
which is only accessible within the Docker network.
"""

import os
import logging
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

logger = logging.getLogger(__name__)

router = APIRouter()

RELAY_API_URL = os.getenv("RELAY_API_URL", "http://equaliser-relay:8008")


class RegisterRequest(BaseModel):
    pubkey: str

    @field_validator("pubkey")
    @classmethod
    def validate_pubkey(cls, v):
        if len(v) != 64 or not all(c in "0123456789abcdef" for c in v):
            raise ValueError("pubkey must be 64 lowercase hex characters")
        return v


@router.post("/register")
async def register_user(req: RegisterRequest):
    """Register a user pubkey with the relay for data caching."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{RELAY_API_URL}/api/internal/users/register",
                json={"pubkey": req.pubkey},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.TimeoutException:
        logger.warning("Relay API timeout registering user %s", req.pubkey[:8])
        raise HTTPException(status_code=504, detail="Relay API timeout")
    except httpx.HTTPStatusError as e:
        logger.warning("Relay API error registering user %s: %s", req.pubkey[:8], e.response.status_code)
        raise HTTPException(status_code=e.response.status_code, detail="Relay registration failed")
    except Exception as e:
        logger.error("Failed to register user %s: %s", req.pubkey[:8], e)
        raise HTTPException(status_code=502, detail="Relay API unavailable")
