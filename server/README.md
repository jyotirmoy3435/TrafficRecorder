# Traffic Recorder - Python Companion Server

A high-performance local ingestion and storage service paired with the Traffic Recorder Chrome Extension.

## Key Architecture & Optimizations
- **FastAPI + Uvicorn:** Asynchronous HTTP server bound strictly to `127.0.0.1` for local developer security.
- **SQLite with WAL Mode:** Configured with `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;` to support ultra-fast batched transactions without locking.
- **Zstandard Adaptive Compression:** Payloads (HTTP bodies and WebSocket frames) are compressed using Zstandard level 3 if size reduces by ≥ 5%; otherwise stored in native format to avoid unnecessary CPU cycles.
- **Content-Addressed Deduplication:** Payloads are hashed using SHA-256. Identical assets and repetitive API responses are stored only once and referenced across transactions.
- **Hybrid Storage Strategy:**
  - Small payloads (≤ 256 KB) are stored directly inside SQLite `payloads.data` BLOBs.
  - Large payloads (> 256 KB) are stored in content-addressed external files (`blobs/{hash[:2]}/{hash}.bin`) to prevent database bloat and excessive WAL checkpoints.
- **Standard HAR 1.2 & JSON Exporters:** Generates valid HTTP Archive (HAR) files compatible with Chrome DevTools, Charles Proxy, Fiddler, Insomnia, and Postman.
- **Built-in Interactive Web Explorer:** A standalone, responsive dark-themed dashboard served directly at `http://127.0.0.1:8765/`.

## Prerequisites
- Python 3.10+
- Installed packages: `pip install -r requirements.txt`

## Running the Server

Run directly with Python from the `server/` directory:
```bash
python server.py
```
*(Or from the workspace root: `python server/server.py`)*

All persistent database files (`traffic.db`) and external payload blobs are stored inside the `server/data/` directory (gitignored).

### Command-Line Options
```bash
python server.py --host 127.0.0.1 --port 8765 --db data/traffic.db
```

## REST API Endpoints

### Ingestion & Session Lifecycle
- `POST /api/v1/session/start` - Register a new recording session
- `POST /api/v1/session/stop` - Finalize a recording session
- `POST /api/v1/ingest` - Ingest an atomic batch of HTTP/WebSocket events

### Inspection & Query
- `GET /api/v1/health` - Server health, uptime, and database storage metrics
- `GET /api/v1/stats` - Compression savings and deduplication statistics
- `GET /api/v1/sessions` - List all recorded sessions with aggregate transaction counts
- `GET /api/v1/sessions/{id}` - Details of a specific session
- `DELETE /api/v1/sessions/{id}` - Delete a session and its associated data
- `GET /api/v1/sessions/{id}/transactions` - Search & filter HTTP requests/responses (query params: `search`, `method`, `status`, `resource_type`, `limit`, `offset`)
- `GET /api/v1/transactions/{id}` - Detailed transaction inspection including headers and formatted body previews
- `GET /api/v1/sessions/{id}/websockets` - List WebSocket connections
- `GET /api/v1/websockets/{id}/messages` - WebSocket frame timeline (query params: `direction`, `limit`, `offset`)
- `GET /api/v1/payloads/{id}/raw` - Download raw decompressed payload
- `GET /api/v1/sessions/{id}/export/har` - Export session as standard HAR 1.2
- `GET /api/v1/sessions/{id}/export/json` - Export session as structured JSON
