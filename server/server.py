#!/usr/bin/env python3
"""
Traffic Recorder Server Starter
Run this file directly from inside the server/ directory:
    python server.py
"""
import sys
from pathlib import Path

# Ensure workspace root directory is on sys.path
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server.main import main

if __name__ == "__main__":
    main()
