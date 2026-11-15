# Traffic Recorder - Chrome Extension

High-fidelity browser network traffic recorder powered by the **Chrome DevTools Protocol (CDP)** and Manifest V3.

## Features
- **Tab-Scoped Recording:** Only records traffic for the tab where recording was explicitly enabled.
- **Standby Auto-Start:** On a new tab or internal page, the recorder arms in **Standby** mode and automatically begins recording the instant you enter a URL and hit Enter, capturing 100% of the initial page requests, redirects, headers, and cookies!
- **Deep Visibility:** Captures full HTTP/HTTPS request and response headers, POST bodies, response bodies, and WebSocket frames (both sent and received).
- **Zero Memory Bloat:** Streams captured data directly to the local companion server in bounded batches; RAM usage stays strictly capped.
- **Navigation Resilient:** Continues recording seamlessly as you navigate between pages within the same tab.
- **Real-Time Popup Dashboard:** Displays live request, response, and WebSocket counters, elapsed timer, and queue transmission metrics.

## Installation in Google Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top right corner.
3. Click the **Load unpacked** button.
4. Select the `extension` directory.
5. The **Traffic Recorder** icon (`⚡`) will appear in your Chrome toolbar. Pin it for quick access.

## How to Use

### Normal Page Recording
1. Make sure the companion server is running (`cd server && python server.py`).
2. Open any website in a Chrome tab.
3. Click the **Traffic Recorder** extension icon.
4. Click **Start Recording This Tab**.
5. Perform actions on the page.
6. Click **Stop Recording** when finished.

### Standby Mode on New Tabs (Captures Initial Page Load)
1. Open a new tab in Chrome (`chrome://newtab`).
2. Click the extension icon.
3. Notice the button shows **Arm on Next Navigation (Standby)**. Click it.
4. The extension enters **STANDBY** (badge shows `ARM`).
5. Type any URL in the address bar (e.g., `github.com` or `example.com`) and press Enter.
6. The recorder automatically attaches at the start of navigation and captures the initial HTML document request, headers, cookies, redirects, and all subsequent traffic!
7. Click **Stop Recording** when finished.
8. Click **Explorer ↗** in the popup or open `http://127.0.0.1:8765/` to inspect all captured traffic.

## Permissions Breakdown
- `debugger`: Required to attach Chrome DevTools Protocol (CDP) to the active tab to extract response bodies and WebSocket frame payloads.
- `tabs`: Queries the active tab URL and title, and detects tab closing.
- `webNavigation`: Detects the start of navigation on armed standby tabs to begin recording immediately.
- `storage`: Persists server host/port and token settings.
- `host_permissions`: Allows network communication with the local server (`127.0.0.1`) and pages being debugged.
