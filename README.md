# Traffic Recorder

A complete, high-fidelity browser traffic capture and persistence solution consisting of:
1. **Chrome Extension (`extension/`):** A Manifest V3 extension that attaches the Chrome DevTools Protocol (`chrome.debugger`) to a single tab on demand, capturing complete HTTP/HTTPS transactions (including headers and bodies) and WebSocket frames with zero tab bloat. Features an **Armed Standby** mode that allows arming the recorder on a new tab so it triggers automatically the millisecond navigation starts!
2. **Companion Server (`server/`):** A high-performance Python FastAPI service backed by SQLite WAL, adaptive Zstandard compression, SHA-256 deduplication, and a hybrid BLOB/file storage engine, complete with an interactive Web Explorer UI and HAR 1.2 exporter.

---

## Architecture Overview

```
+-------------------------------------------------------------------------+
|                              GOOGLE CHROME                              |
|                                                                         |
|  +--------------------+        +-------------------------------------+  |
|  | User Tab (Target)  | <====> | Traffic Recorder Extension (MV3)    |  |
|  | - Web Browsing     |  CDP   | - Popup UI (Start/Stop/Arm controls)|  |
|  | - HTTP / Fetch/XHR | Network| - Service Worker & Event Collector  |  |
|  | - WebSockets       | Domain | - Standby on Navigation Trigger     |  |
|  +--------------------+        +-------------------------------------+  |
+-------------------------------------------|-----------------------------+
                                            | Batched Ingestion
                                            | (POST /api/v1/ingest)
                                            v
+-------------------------------------------------------------------------+
|                  PYTHON COMPANION SERVICE (127.0.0.1:8765)              |
|                                                                         |
|  FastAPI Ingestion API  <----->  Adaptive Zstandard Compressor (Level 3)|
|           |                                       |                     |
|           v                                       v                     |
|  Atomic SQLite Ingestion Engine       SHA-256 Content Deduplication     |
|           |                                       |                     |
|  +--------------------------------+       +--------------------------+  |
|  | SQLite Database (traffic.db)   |       | Content-Addressed Blobs  |  |
|  | - PRAGMA journal_mode = WAL    |       | (Payloads > 256 KB)      |  |
|  | - Sessions & HTTP Transactions |       | blobs/{hash[:2]}/{hash}  |  |
|  | - Headers & Payload References |       +--------------------------+  |
|  | - WebSocket Connections/Frames |                                     |
|  | - Small Payloads (<= 256 KB)   |                                     |
|  +--------------------------------+                                     |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  | Built-in Web Explorer (http://127.0.0.1:8765/)                    |  |
|  | - Filterable HTTP Requests/Responses & Header/Body Viewers        |  |
|  | - Live WebSocket Frame Stream Timeline                            |  |
|  | - Standard HAR 1.2 & Structured JSON Exporters                    |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+
```

---

## Directory Structure

```
.
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json                # Extension manifest with debugger, tabs, webNavigation
│   ├── background/                  # Background Service Worker modules
│   │   ├── service-worker.js        # Main worker, state manager & standby handler
│   │   ├── debugger-manager.js      # CDP attachment & lifecycle handler
│   │   ├── event-collector.js       # CDP Network event normalization
│   │   ├── queue-manager.js         # Bounded memory queue & batch transmitter
│   │   └── api-client.js            # Companion server HTTP client
│   ├── popup/                       # Extension Action Popup UI
│   │   ├── popup.html               # Popup layout
│   │   ├── popup.css                # Sleek dark mode styling with standby indicators
│   │   └── popup.js                 # Controls, standby/arm triggers, metrics
│   ├── icons/                       # Extension icons (16x16, 48x48, 128x128)
│   └── README.md                    # Extension documentation
│
├── server/                          # Python Companion Server
│   ├── main.py                      # Server entry point & FastAPI application
│   ├── config.py                    # Server configuration & storage limits
│   ├── db.py                        # SQLite connection & schema initialization
│   ├── compressor.py                # Zstandard compression & SHA-256 hashing
│   ├── storage.py                   # Hybrid BLOB/file store with deduplication
│   ├── models.py                    # Pydantic schemas for API endpoints
│   ├── ingest.py                    # High-throughput batch ingestion pipeline
│   ├── exporter.py                  # Standard HAR 1.2 and JSON export engine
│   ├── api.py                       # REST API routes
│   ├── static/                      # Interactive Web Explorer UI
│   │   ├── index.html               # Dashboard HTML
│   │   ├── viewer.css               # DevTools-inspired theme
│   │   └── viewer.js                # Frontend client logic & syntax decoders
│   ├── requirements.txt             # Python package dependencies
│   ├── server.py                    # Server launcher
│   ├── data/                        # SQLite databases & payload blobs (gitignored)
│   └── README.md                    # Server documentation
│
└── chrome-traffic-visibility-20261115.md # Original design & requirements discussion (gitignored)
```

---

## Quick Start Guide

### Step 1: Start the Companion Server
Run directly with Python from the `server/` folder:
```cmd
cd server
python server.py
```
*(Or from the project root: `python server/server.py`)*
The server will start on `http://127.0.0.1:8765`.
You can verify it's running by opening `http://127.0.0.1:8765/` in your browser.

### Step 2: Load the Chrome Extension
1. Open Chrome and go to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top right corner.
3. Click **Load unpacked**.
4. Choose the `extension` folder.
5. Pin the extension icon (`⚡`) to your browser toolbar.

### Step 3: Record Traffic

#### Option A: Normal Webpage Recording
1. Open any tab you wish to record (e.g. `https://news.ycombinator.com`).
2. Click the extension icon and click **Start Recording This Tab**.
3. Perform your actions, then click **Stop Recording**.

#### Option B: Standby Mode on New Tabs (Captures Initial Page Load)
1. Open a new tab (`chrome://newtab`).
2. Click the extension icon. The button will say **Arm on Next Navigation (Standby)**.
3. Click the button. The extension enters **STANDBY** (badge shows `ARM`).
4. Type any URL in the omnibox and press Enter.
5. The extension automatically attaches and starts recording the instant navigation begins, capturing 100% of the initial document request, redirects, and cookies!
6. Click **Stop Recording** when done.

### Step 4: Inspect & Export Traffic
1. Click **Explorer ↗** in the popup or open `http://127.0.0.1:8765/` in your browser.
2. In the Web Explorer:
   - Browse recorded sessions.
   - Filter HTTP transactions by method, status code, or keyword.
   - View formatted JSON, request/response headers, and raw downloads.
   - Inspect live WebSocket frame timelines (⬆ Sent / ⬇ Received).
   - Export HAR 1.2 files compatible with Chrome DevTools and Postman.
