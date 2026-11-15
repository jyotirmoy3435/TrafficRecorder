"""
Hybrid payload storage engine.
Stores small payloads (<=256KB) as SQLite BLOBs and large payloads (>256KB)
as content-addressed files. Supports SHA-256 deduplication and adaptive Zstandard compression.
"""
import os
import time
import tempfile
from pathlib import Path
from typing import Optional, Tuple
import sqlite3

from server.config import BLOBS_DIR, LARGE_PAYLOAD_THRESHOLD
from server import compressor


def store_payload(
    conn: sqlite3.Connection,
    raw_bytes: bytes,
    mime_type: Optional[str] = None
) -> int:
    """
    Store payload with content deduplication and adaptive compression.
    Returns: payload_id (INTEGER PRIMARY KEY)
    """
    if raw_bytes is None:
        raw_bytes = b""

    original_size = len(raw_bytes)
    digest = compressor.sha256_hash(raw_bytes)

    # 1. Deduplication check: check if payload already exists
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM payloads WHERE sha256 = ?", (digest,))
    existing = cursor.fetchone()
    if existing:
        return existing[0]

    # 2. Adaptive compression
    stored_bytes, encoding, is_compressed = compressor.compress(raw_bytes)
    stored_size = len(stored_bytes)
    now = int(time.time() * 1000)

    # 3. Hybrid storage decision: BLOB vs External File
    if stored_size <= LARGE_PAYLOAD_THRESHOLD:
        storage_type = 0  # SQLite BLOB
        db_blob = stored_bytes
        external_path = None
    else:
        storage_type = 1  # External file
        db_blob = None
        # Shard by first two characters of SHA-256 to prevent thousands of files in one directory
        shard_dir = BLOBS_DIR / digest[:2]
        shard_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{digest}.bin"
        file_path = shard_dir / filename
        rel_path = f"{digest[:2]}/{filename}"

        # Atomic file write: write to temp file then rename
        temp_file = tempfile.NamedTemporaryFile(dir=shard_dir, delete=False)
        try:
            temp_file.write(stored_bytes)
            temp_file.flush()
            temp_file.close()
            os.replace(temp_file.name, file_path)
        except Exception:
            if os.path.exists(temp_file.name):
                os.remove(temp_file.name)
            raise

        external_path = rel_path

    # 4. Insert into database
    cursor.execute(
        """
        INSERT INTO payloads (
            sha256, original_size, stored_size, encoding,
            storage_type, data, external_path, mime_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            digest,
            original_size,
            stored_size,
            encoding,
            storage_type,
            db_blob,
            external_path,
            mime_type,
            now,
        ),
    )
    return cursor.lastrowid


def retrieve_payload(
    conn: sqlite3.Connection,
    payload_id: int
) -> Tuple[bytes, Optional[str], str, int, int]:
    """
    Retrieve and decompress payload by ID.
    Returns: (raw_decompressed_bytes, mime_type, encoding, original_size, stored_size)
    """
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT sha256, original_size, stored_size, encoding,
               storage_type, data, external_path, mime_type
        FROM payloads WHERE id = ?
        """,
        (payload_id,),
    )
    row = cursor.fetchone()
    if not row:
        raise KeyError(f"Payload ID {payload_id} not found")

    original_size = row["original_size"]
    stored_size = row["stored_size"]
    encoding = row["encoding"]
    storage_type = row["storage_type"]
    db_blob = row["data"]
    external_path = row["external_path"]
    mime_type = row["mime_type"]

    if storage_type == 0:
        stored_bytes = db_blob if db_blob is not None else b""
    else:
        target_path = BLOBS_DIR / external_path
        if not target_path.exists():
            raise FileNotFoundError(f"External payload file missing: {target_path}")
        with open(target_path, "rb") as f:
            stored_bytes = f.read()

    # Decompress back to original bytes
    decompressed = compressor.decompress(stored_bytes, encoding)
    return decompressed, mime_type, encoding, original_size, stored_size
