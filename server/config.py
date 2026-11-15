"""
Configuration settings for the Traffic Recorder Companion Server.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Server Network Configuration
# Bind exclusively to 127.0.0.1 for local security
HOST = os.getenv("RECORDER_HOST", "127.0.0.1")
PORT = int(os.getenv("RECORDER_PORT", "8765"))

# Storage Configuration
# Store all database files and external blobs inside a dedicated data directory
DATA_DIR = Path(os.getenv("RECORDER_DATA_DIR", str(BASE_DIR / "data")))
DATABASE_PATH = Path(os.getenv("RECORDER_DB", str(DATA_DIR / "traffic.db")))
BLOBS_DIR = Path(os.getenv("RECORDER_BLOBS", str(DATA_DIR / "blobs")))

# Threshold above which payloads are stored in external files instead of SQLite BLOBs
# 256 KB = 262,144 bytes
LARGE_PAYLOAD_THRESHOLD = 262144

# Compression settings
# Zstd level 3 offers the best balance between compression speed and ratio
ZSTD_LEVEL = 3
# If compressed data is not at least 5% smaller, keep original to save CPU
COMPRESSION_SAVINGS_THRESHOLD = 0.95

# Optional security token (if empty, token validation is relaxed for local developer use)
API_TOKEN = os.getenv("RECORDER_API_TOKEN", "")

# Ensure storage directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
BLOBS_DIR.mkdir(parents=True, exist_ok=True)
