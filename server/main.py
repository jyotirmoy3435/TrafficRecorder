"""
Main entry point for the Traffic Recorder Companion Server.
Runs FastAPI with Uvicorn, SQLite WAL, and adaptive Zstandard hybrid payload storage.
"""
import argparse
import os
import sys
from pathlib import Path
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BASE_DIR.parent))

from server import config
from server.api import router as api_router
from server.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite database and WAL mode on startup
    init_db(config.DATABASE_PATH)
    print(f"[TrafficRecorder] SQLite Database initialized at: {config.DATABASE_PATH} (WAL mode)")
    print(f"[TrafficRecorder] Payload Blobs directory: {config.BLOBS_DIR}")
    yield


app = FastAPI(
    title="Traffic Recorder Companion Server",
    description="High-fidelity HTTP/WebSocket traffic ingestion and query service",
    version="1.1.0",
    lifespan=lifespan,
)

# Enable CORS for Chrome Extension communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes under /api/v1
app.include_router(api_router, prefix="/api/v1")

# Mount Static Web Viewer UI
static_dir = BASE_DIR / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")


def main():
    parser = argparse.ArgumentParser(description="Traffic Recorder Server")
    parser.add_argument("--host", default=config.HOST, help="Host to bind to (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=config.PORT, help="Port to listen on (default: 8765)")
    parser.add_argument("--db", default=None, help="Custom SQLite database file path")
    args = parser.parse_args()

    if args.db:
        config.DATABASE_PATH = Path(args.db).resolve()
        config.DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

    host = args.host
    port = args.port

    print("=" * 64)
    print("  ⚡ Traffic Recorder Companion Server")
    print("=" * 64)
    print(f"  • Ingestion API:  http://{host}:{port}/api/v1")
    print(f"  • Web Explorer:   http://{host}:{port}/")
    print(f"  • Storage Engine: SQLite WAL + Zstandard Hybrid Blobs")
    print("=" * 64)
    print("Press Ctrl+C to stop the server.\n")

    uvicorn.run("server.main:app", host=host, port=port, log_level="info", reload=False)


if __name__ == "__main__":
    main()
