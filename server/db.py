"""
Database connection management and schema migration for SQLite.
Optimized for high-throughput append operations using Write-Ahead Logging (WAL).
"""
import sqlite3
import threading
from pathlib import Path
from typing import Generator
from server.config import DATABASE_PATH

# Thread-local storage for SQLite connections
_local = threading.local()

SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000; -- 64MB cache

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    tab_id INTEGER,
    initial_url TEXT,
    title TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'recording', -- 'recording', 'completed', 'aborted'
    stats_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS http_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT NOT NULL,
    resource_type TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms REAL,
    status_code INTEGER,
    status_text TEXT,
    mime_type TEXT,
    protocol TEXT,
    from_cache INTEGER DEFAULT 0,
    error TEXT,
    request_payload_id INTEGER,
    response_payload_id INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (request_payload_id) REFERENCES payloads(id),
    FOREIGN KEY (response_payload_id) REFERENCES payloads(id)
);

CREATE TABLE IF NOT EXISTS http_headers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    direction INTEGER NOT NULL, -- 0 = Request, 1 = Response
    sequence INTEGER NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY (transaction_id) REFERENCES http_transactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT UNIQUE NOT NULL,
    original_size INTEGER NOT NULL,
    stored_size INTEGER NOT NULL,
    encoding TEXT NOT NULL, -- 'zstd', 'identity', 'deflate'
    storage_type INTEGER NOT NULL, -- 0 = SQLite BLOB, 1 = External File
    data BLOB,
    external_path TEXT,
    mime_type TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payload_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL, -- 'http_request', 'http_response', 'websocket_message'
    target_id INTEGER NOT NULL,
    payload_id INTEGER NOT NULL,
    FOREIGN KEY (payload_id) REFERENCES payloads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS websocket_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS websocket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    direction INTEGER NOT NULL, -- 0 = Sent (outgoing), 1 = Received (incoming)
    timestamp INTEGER NOT NULL,
    opcode INTEGER NOT NULL, -- 1=text, 2=binary, 8=close, 9=ping, 10=pong
    is_binary INTEGER NOT NULL DEFAULT 0,
    payload_id INTEGER NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES websocket_connections(id) ON DELETE CASCADE,
    FOREIGN KEY (payload_id) REFERENCES payloads(id)
);

CREATE TABLE IF NOT EXISTS capture_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    request_id TEXT,
    event_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Indexes for lightning fast lookups & filtering
CREATE INDEX IF NOT EXISTS idx_sessions_sid ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_http_sess_time ON http_transactions(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_http_sess_req ON http_transactions(session_id, request_id);
CREATE INDEX IF NOT EXISTS idx_http_url ON http_transactions(url);
CREATE INDEX IF NOT EXISTS idx_http_headers_txn ON http_headers(transaction_id, direction);
CREATE INDEX IF NOT EXISTS idx_payloads_sha ON payloads(sha256);
CREATE INDEX IF NOT EXISTS idx_ws_conn_sess ON websocket_connections(session_id, request_id);
CREATE INDEX IF NOT EXISTS idx_ws_msg_conn ON websocket_messages(connection_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_errors_sess ON capture_errors(session_id);
"""


def get_connection(db_path: Path = DATABASE_PATH) -> sqlite3.Connection:
    """
    Get a thread-local SQLite connection with proper PRAGMAs and row factory.
    """
    conn = getattr(_local, "connection", None)
    if conn is None:
        conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA temp_store = MEMORY;")
        _local.connection = conn
    return conn


def init_db(db_path: Path = DATABASE_PATH) -> None:
    """Initialize database tables and indexes."""
    conn = get_connection(db_path)
    with conn:
        conn.executescript(SCHEMA_SQL)
