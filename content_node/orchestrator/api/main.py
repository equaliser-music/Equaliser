"""
Equaliser Orchestrator API

FastAPI backend for the content node orchestrator.
Handles track uploads, HLS encoding, IPFS storage, and NOSTR event publishing.
"""

import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Configure logging so all app loggers output to stdout
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s:%(name)s: %(message)s"
)

from routers import tracks
from routers import drafts
from routers import packages
from routers import users
from routers import uploads
from routers import auth
from routers import label
from routers import operator
from routers import access
from routers import delegations
import asyncio
import time

from services.database import init_db
from services.node_identity import init_node_identity
from services.blossom_cleanup import run_cleanup_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database and node identity on startup."""
    await init_db()
    await init_node_identity()

    # Start Blossom orphan cleanup background task
    cleanup_task = asyncio.create_task(run_cleanup_loop())

    yield

    # Cancel cleanup task on shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="Equaliser Orchestrator",
    description="Content node orchestrator API for track uploads and management",
    version="0.1.0",
    lifespan=lifespan
)

# CORS — restrict origins via ALLOWED_ORIGINS env var (comma-separated)
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost,http://localhost:80").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(tracks.router, prefix="/api/tracks", tags=["tracks"])
app.include_router(drafts.router, prefix="/api/drafts", tags=["drafts"])
app.include_router(packages.router, prefix="/api/releases", tags=["packages"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(uploads.router, prefix="/api/upload", tags=["uploads"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(label.router, prefix="/api/label", tags=["label"])
app.include_router(operator.router, prefix="/api/operator", tags=["operator"])
app.include_router(access.router, prefix="/api/access", tags=["access"])
app.include_router(delegations.router, prefix="/api/delegations", tags=["delegations"])


@app.get("/health")
@app.get("/api/health")
async def health_check():
    """Health check endpoint for container orchestration.
    Exposes server_time so clients can detect/correct NIP-98 clock skew."""
    return {
        "status": "healthy",
        "server_time": int(time.time() * 1000),
    }


# Client config — exposes non-sensitive environment settings for the browser client
STANDARD_RELAYS = [r.strip() for r in os.getenv("STANDARD_RELAYS", "").split(",") if r.strip()]
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")

@app.get("/api/config")
async def get_config():
    """Return client-facing configuration derived from server environment."""
    return {
        "standard_relays": STANDARD_RELAYS,
        "public_base_url": PUBLIC_BASE_URL,
    }


@app.get("/")
@app.get("/api")
async def root():
    """Root endpoint with API info."""
    return {
        "service": "Equaliser Orchestrator",
        "version": "0.1.0",
        "docs": "/docs"
    }
