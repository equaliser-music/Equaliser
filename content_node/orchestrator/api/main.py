"""
Equaliser Orchestrator API

FastAPI backend for the content node orchestrator.
Handles track uploads, HLS encoding, IPFS storage, and NOSTR event publishing.
"""

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import tracks

app = FastAPI(
    title="Equaliser Orchestrator",
    description="Content node orchestrator API for track uploads and management",
    version="0.1.0"
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(tracks.router, prefix="/api/tracks", tags=["tracks"])


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
