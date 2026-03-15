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
import asyncio

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


@app.get("/health")
@app.get("/api/health")
async def health_check():
    """Health check endpoint for container orchestration."""
    return {"status": "healthy"}


@app.get("/")
@app.get("/api")
async def root():
    """Root endpoint with API info."""
    return {
        "service": "Equaliser Orchestrator",
        "version": "0.1.0",
        "docs": "/docs"
    }
