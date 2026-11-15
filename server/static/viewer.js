/**
 * Traffic Explorer - Web Client Frontend Logic
 */

let currentSessionId = null;
let currentTransactionId = null;
let activeWsConnectionId = null;
let autoRefreshTimer = null;
let isAutoRefresh = true;
let allTransactions = [];

document.addEventListener("DOMContentLoaded", () => {
  initUI();
  checkServerHealth();
  loadSessions();

  // Auto-refresh poll every 2.5 seconds
  autoRefreshTimer = setInterval(() => {
    if (isAutoRefresh) {
      checkServerHealth();
      loadSessions(false); // background refresh
      if (currentSessionId) {
        loadSessionData(currentSessionId, false);
      }
    }
  }, 2500);
});

function initUI() {
  // Main Tab Navigation
  document.querySelectorAll(".nav-tabs .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tabs .tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const targetPane = document.getElementById(btn.dataset.tab);
      if (targetPane) targetPane.classList.add("active");
    });
  });

  // Drawer Tab Navigation
  document.querySelectorAll(".drawer-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".drawer-tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".drawer-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const targetPane = document.getElementById(btn.dataset.dtab);
      if (targetPane) targetPane.classList.add("active");
    });
  });

  // Close Drawer
  document.getElementById("btnCloseDrawer").addEventListener("click", () => {
    document.getElementById("inspectorDrawer").classList.remove("open");
    document.querySelectorAll("#httpTableBody tr").forEach((r) => r.classList.remove("selected"));
  });

  // Refresh sessions
  document.getElementById("btnRefreshSessions").addEventListener("click", () => loadSessions());

  // Auto refresh toggle
  const btnAutoRefresh = document.getElementById("btnAutoRefresh");
  btnAutoRefresh.addEventListener("click", () => {
    isAutoRefresh = !isAutoRefresh;
    document.getElementById("autoRefreshStatus").innerText = isAutoRefresh ? "ON" : "OFF";
    btnAutoRefresh.classList.toggle("btn-secondary", !isAutoRefresh);
    btnAutoRefresh.classList.toggle("btn-primary", isAutoRefresh);
  });

  // Export buttons
  document.getElementById("btnExportHar").addEventListener("click", () => {
    if (currentSessionId) {
      window.location.href = `/api/v1/sessions/${currentSessionId}/export/har`;
    }
  });

  document.getElementById("btnExportJson").addEventListener("click", () => {
    if (currentSessionId) {
      window.location.href = `/api/v1/sessions/${currentSessionId}/export/json`;
    }
  });

  // Delete session
  document.getElementById("btnDeleteSession").addEventListener("click", async () => {
    if (!currentSessionId) return;
    if (confirm("Are you sure you want to permanently delete this recorded session?")) {
      await fetch(`/api/v1/sessions/${currentSessionId}`, { method: "DELETE" });
      currentSessionId = null;
      document.getElementById("sessionHero").style.display = "none";
      document.getElementById("inspectorDrawer").classList.remove("open");
      loadSessions();
    }
  });

  // Filters & Search
  document.getElementById("httpSearch").addEventListener("input", applyHttpFilters);
  document.getElementById("filterMethod").addEventListener("change", applyHttpFilters);
  document.getElementById("filterStatus").addEventListener("change", applyHttpFilters);
  document.getElementById("filterType").addEventListener("change", applyHttpFilters);

  // Copy Buttons
  document.getElementById("btnCopyReqPayload").addEventListener("click", () => {
    const text = document.getElementById("reqPayloadContent").innerText;
    navigator.clipboard.writeText(text);
    showTemporaryTooltip("btnCopyReqPayload", "Copied!");
  });

  document.getElementById("btnCopyRespPayload").addEventListener("click", () => {
    const text = document.getElementById("respPayloadContent").innerText;
    navigator.clipboard.writeText(text);
    showTemporaryTooltip("btnCopyRespPayload", "Copied!");
  });
}

function showTemporaryTooltip(btnId, text) {
  const btn = document.getElementById(btnId);
  const orig = btn.innerText;
  btn.innerText = text;
  setTimeout(() => (btn.innerText = orig), 1500);
}

async function checkServerHealth() {
  try {
    const res = await fetch("/api/v1/health");
    if (res.ok) {
      const data = await res.json();
      const statusEl = document.getElementById("serverStatus");
      statusEl.className = "server-status online";
      statusEl.querySelector(".status-text").innerText = `Live (${formatBytes(data.db_size_bytes)})`;

      // Stats
      const statsRes = await fetch("/api/v1/stats");
      if (statsRes.ok) {
        const stats = await statsRes.json();
        document.getElementById("savingsPercent").innerText = `${stats.compression_savings_percent}% (${formatBytes(stats.compression_savings_bytes)})`;
      }
    }
  } catch (err) {
    const statusEl = document.getElementById("serverStatus");
    statusEl.className = "server-status";
    statusEl.querySelector(".status-text").innerText = "Offline";
  }
}

async function loadSessions(showLoading = true) {
  try {
    const res = await fetch("/api/v1/sessions");
    if (!res.ok) return;
    const sessions = await res.json();
    const container = document.getElementById("sessionList");

    if (sessions.length === 0) {
      container.innerHTML = `<div class="empty-state">No recorded sessions yet. Click the Traffic Recorder Chrome extension to start recording any tab.</div>`;
      return;
    }

    let html = "";
    sessions.forEach((s) => {
      const isSelected = s.session_id === currentSessionId;
      const isRecording = s.status === "recording";
      const title = s.title || s.initial_url || `Session ${s.session_id.substring(0, 8)}`;
      const url = s.initial_url || "about:blank";
      const dateStr = new Date(s.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      html += `
        <div class="session-card ${isSelected ? "active" : ""}" onclick="selectSession('${s.session_id}')">
          <div class="session-card-title">${escapeHtml(title)}</div>
          <div class="session-card-url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
          <div class="session-card-footer">
            <span>${dateStr}</span>
            <div class="session-badges">
              ${isRecording ? '<span class="badge-recording">● REC</span>' : ""}
              <span class="badge-count">HTTP: ${s.http_count}</span>
              <span class="badge-count">WS: ${s.ws_conn_count}</span>
            </div>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;

    // If no session selected yet, auto-select the latest one
    if (!currentSessionId && sessions.length > 0) {
      selectSession(sessions[0].session_id);
    }
  } catch (e) {
    console.error("Failed to load sessions:", e);
  }
}

async function selectSession(sessionId) {
  currentSessionId = sessionId;
  document.getElementById("btnExportHar").disabled = false;
  document.getElementById("btnExportJson").disabled = false;

  // Highlight card
  document.querySelectorAll(".session-card").forEach((c) => c.classList.remove("active"));
  const cards = document.querySelectorAll(".session-card");
  // Find card with matching onclick
  cards.forEach((card) => {
    if (card.getAttribute("onclick")?.includes(sessionId)) {
      card.classList.add("active");
    }
  });

  await loadSessionData(sessionId, true);
}

async function loadSessionData(sessionId, resetDrawer = false) {
  try {
    // 1. Session detail
    const sRes = await fetch(`/api/v1/sessions/${sessionId}`);
    if (sRes.ok) {
      const s = await sRes.json();
      document.getElementById("sessionHero").style.display = "flex";
      document.getElementById("heroTitle").innerText = s.title || s.initial_url || "Session " + sessionId;
      document.getElementById("heroMeta").innerText = `Started: ${new Date(s.started_at).toLocaleString()} • Tab: ${s.tab_id || "N/A"} • Status: ${s.status.toUpperCase()}`;
    }

    // 2. HTTP Transactions
    const tRes = await fetch(`/api/v1/sessions/${sessionId}/transactions?limit=500`);
    if (tRes.ok) {
      const tData = await tRes.json();
      allTransactions = tData.items || [];
      document.getElementById("countHttp").innerText = allTransactions.length;
      renderHttpTable(allTransactions);
    }

    // 3. WebSockets
    const wsRes = await fetch(`/api/v1/sessions/${sessionId}/websockets`);
    if (wsRes.ok) {
      const wsConns = await wsRes.json();
      document.getElementById("countWs").innerText = wsConns.length;
      renderWsConnections(wsConns);
    }

    // 4. Errors
    const errRes = await fetch(`/api/v1/sessions/${sessionId}/errors`);
    if (errRes.ok) {
      const errors = await errRes.json();
      document.getElementById("countErrors").innerText = errors.length;
      renderErrorsTable(errors);
    }

    if (resetDrawer) {
      document.getElementById("inspectorDrawer").classList.remove("open");
    }
  } catch (err) {
    console.error("Failed to load session data:", err);
  }
}

function applyHttpFilters() {
  const query = document.getElementById("httpSearch").value.toLowerCase().trim();
  const method = document.getElementById("filterMethod").value;
  const status = document.getElementById("filterStatus").value;
  const type = document.getElementById("filterType").value;

  const filtered = allTransactions.filter((t) => {
    if (query && !t.url.toLowerCase().includes(query) && !(t.mime_type || "").toLowerCase().includes(query)) {
      return false;
    }
    if (method && t.method !== method) return false;
    if (status) {
      const sGroup = status.substring(0, 1);
      const tGroup = String(t.status_code || "").substring(0, 1);
      if (status.endsWith("00") && tGroup !== sGroup) return false;
      if (!status.endsWith("00") && String(t.status_code) !== status) return false;
    }
    if (type && t.resource_type !== type) return false;
    return true;
  });

  renderHttpTable(filtered);
}

function renderHttpTable(items) {
  const tbody = document.getElementById("httpTableBody");
  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="placeholder-cell">No matching HTTP requests recorded.</td></tr>`;
    return;
  }

  let html = "";
  items.forEach((item) => {
    const isSelected = item.id === currentTransactionId;
    const statusClass = getStatusClass(item.status_code, item.error);
    const statusDisplay = item.status_code ? item.status_code : (item.error ? "ERR" : "—");
    const durationDisplay = item.duration_ms ? `${item.duration_ms} ms` : "—";
    const timeDisplay = new Date(item.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    html += `
      <tr class="${isSelected ? "selected" : ""}" onclick="selectTransaction(${item.id})">
        <td class="${statusClass}">${statusDisplay}</td>
        <td><span class="badge-method badge-${item.method}">${item.method}</span></td>
        <td title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</td>
        <td>${escapeHtml(item.resource_type || "—")}</td>
        <td title="${escapeHtml(item.mime_type || "")}">${escapeHtml(item.mime_type || "—")}</td>
        <td>${durationDisplay}</td>
        <td>${timeDisplay}</td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

function getStatusClass(code, error) {
  if (error) return "status-err";
  if (!code) return "";
  if (code >= 200 && code < 300) return "status-2xx";
  if (code >= 300 && code < 400) return "status-3xx";
  if (code >= 400 && code < 500) return "status-4xx";
  if (code >= 500) return "status-5xx";
  return "";
}

async function selectTransaction(txnId) {
  currentTransactionId = txnId;

  // Highlight table row
  document.querySelectorAll("#httpTableBody tr").forEach((r) => r.classList.remove("selected"));
  // Re-highlight clicked row
  const row = event?.currentTarget;
  if (row) row.classList.add("selected");

  // Fetch full details
  try {
    const res = await fetch(`/api/v1/transactions/${txnId}`);
    if (!res.ok) return;
    const txn = await res.json();
    populateInspector(txn);
    document.getElementById("inspectorDrawer").classList.add("open");
  } catch (err) {
    console.error("Failed to load transaction details:", err);
  }
}

function populateInspector(txn) {
  document.getElementById("drawerTitle").innerText = `${txn.method} ${txn.url}`;

  // 1. General Info
  const genGrid = document.getElementById("generalHeaders");
  genGrid.innerHTML = `
    <div class="kv-row"><div class="kv-key">Request URL</div><div class="kv-val">${escapeHtml(txn.url)}</div></div>
    <div class="kv-row"><div class="kv-key">Request Method</div><div class="kv-val">${txn.method}</div></div>
    <div class="kv-row"><div class="kv-key">Status Code</div><div class="kv-val ${getStatusClass(txn.status_code, txn.error)}">${txn.status_code || "—"} ${txn.status_text || ""}</div></div>
    <div class="kv-row"><div class="kv-key">Protocol</div><div class="kv-val">${txn.protocol || "—"}</div></div>
    <div class="kv-row"><div class="kv-key">Resource Type</div><div class="kv-val">${txn.resource_type || "—"}</div></div>
    <div class="kv-row"><div class="kv-key">Duration</div><div class="kv-val">${txn.duration_ms ? txn.duration_ms + " ms" : "—"}</div></div>
    <div class="kv-row"><div class="kv-key">From Cache</div><div class="kv-val">${txn.from_cache ? "Yes" : "No"}</div></div>
    ${txn.error ? `<div class="kv-row"><div class="kv-key" style="color:var(--accent-red);">Error</div><div class="kv-val" style="color:var(--accent-red);">${escapeHtml(txn.error)}</div></div>` : ""}
  `;

  // 2. Request Headers
  const reqGrid = document.getElementById("reqHeaders");
  document.getElementById("reqHeadersCount").innerText = (txn.request_headers || []).length;
  reqGrid.innerHTML = renderHeadersList(txn.request_headers);

  // 3. Response Headers
  const respGrid = document.getElementById("respHeaders");
  document.getElementById("respHeadersCount").innerText = (txn.response_headers || []).length;
  respGrid.innerHTML = renderHeadersList(txn.response_headers);

  // 4. Request Body
  const reqBodyBox = document.getElementById("reqPayloadContent");
  const reqMeta = document.getElementById("reqPayloadMeta");
  const btnCopyReq = document.getElementById("btnCopyReqPayload");
  if (txn.request_body && txn.request_body.preview) {
    reqMeta.innerText = `Size: ${formatBytes(txn.request_body.original_size)} • Type: ${txn.request_body.mime_type || "text"}`;
    reqBodyBox.innerText = formatCode(txn.request_body.preview, txn.request_body.mime_type);
    btnCopyReq.style.display = "inline-block";
  } else {
    reqMeta.innerText = "No request payload sent.";
    reqBodyBox.innerText = "";
    btnCopyReq.style.display = "none";
  }

  // 5. Response Body
  const respBodyBox = document.getElementById("respPayloadContent");
  const respMeta = document.getElementById("respPayloadMeta");
  const btnCopyResp = document.getElementById("btnCopyRespPayload");
  const btnDlResp = document.getElementById("btnDownloadRespPayload");

  if (txn.response_body && (txn.response_body.preview || txn.response_body.has_raw)) {
    const origSz = formatBytes(txn.response_body.original_size);
    const storedSz = formatBytes(txn.response_body.stored_size);
    const enc = txn.response_body.encoding || "identity";
    respMeta.innerText = `Original: ${origSz} • Stored (${enc}): ${storedSz}`;

    if (txn.response_body.preview) {
      respBodyBox.innerText = formatCode(txn.response_body.preview, txn.response_body.mime_type);
      btnCopyResp.style.display = "inline-block";
    } else {
      respBodyBox.innerText = `<Binary content: ${origSz} • Click Download Raw to view>`;
      btnCopyResp.style.display = "none";
    }

    btnDlResp.href = `/api/v1/payloads/${txn.response_body.payload_id}/raw`;
    btnDlResp.style.display = "inline-block";
  } else {
    respMeta.innerText = "No response body captured.";
    respBodyBox.innerText = "";
    btnCopyResp.style.display = "none";
    btnDlResp.style.display = "none";
  }
}

function renderHeadersList(headers) {
  if (!headers || headers.length === 0) {
    return `<div class="placeholder-cell" style="padding:10px !important;">No headers present</div>`;
  }
  return headers
    .map(
      (h) => `
    <div class="kv-row">
      <div class="kv-key">${escapeHtml(h.name)}</div>
      <div class="kv-val">${escapeHtml(h.value)}</div>
    </div>
  `
    )
    .join("");
}

function renderWsConnections(conns) {
  const container = document.getElementById("wsConnList");
  if (!conns || conns.length === 0) {
    container.innerHTML = `<div class="placeholder-cell" style="padding:15px !important;">No WebSockets captured.</div>`;
    document.getElementById("wsMessagesList").innerHTML = `<div class="placeholder-cell">No WebSockets captured.</div>`;
    return;
  }

  let html = "";
  conns.forEach((c) => {
    const isSelected = c.id === activeWsConnectionId;
    html += `
      <div class="ws-conn-item ${isSelected ? "active" : ""}" onclick="selectWsConnection(${c.id})">
        <div class="ws-conn-url" title="${escapeHtml(c.url)}">${escapeHtml(c.url)}</div>
        <div class="ws-conn-stats">Frames: ${c.message_count} (⬆ ${c.sent_count} • ⬇ ${c.received_count})</div>
      </div>
    `;
  });
  container.innerHTML = html;

  // Auto-select first connection if not selected
  if (!activeWsConnectionId && conns.length > 0) {
    selectWsConnection(conns[0].id);
  }
}

async function selectWsConnection(connId) {
  activeWsConnectionId = connId;
  document.querySelectorAll(".ws-conn-item").forEach((item) => item.classList.remove("active"));
  // Highlight clicked
  event?.currentTarget?.classList?.add("active");

  try {
    const res = await fetch(`/api/v1/websockets/${connId}/messages?limit=300`);
    if (!res.ok) return;
    const data = await res.json();
    renderWsMessages(data.items || []);
  } catch (e) {
    console.error("Failed to load WS messages:", e);
  }
}

function renderWsMessages(messages) {
  const container = document.getElementById("wsMessagesList");
  if (!messages || messages.length === 0) {
    container.innerHTML = `<div class="placeholder-cell">No frames exchanged on this connection.</div>`;
    return;
  }

  let html = "";
  messages.forEach((m) => {
    const isSent = m.direction === 0;
    const dirClass = isSent ? "ws-dir-sent" : "ws-dir-recv";
    const dirText = isSent ? "⬆ Sent" : "⬇ Recv";
    const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    html += `
      <div class="ws-msg-row">
        <span class="ws-dir ${dirClass}">${dirText}</span>
        <span class="ws-time">${timeStr}</span>
        <div class="ws-payload">${escapeHtml(m.preview)}</div>
      </div>
    `;
  });
  container.innerHTML = html;
}

function renderErrorsTable(errors) {
  const tbody = document.getElementById("errorsTableBody");
  if (!errors || errors.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="placeholder-cell">No capture errors or warnings reported for this session.</td></tr>`;
    return;
  }

  let html = "";
  errors.forEach((e) => {
    const timeStr = new Date(e.timestamp).toLocaleTimeString();
    html += `
      <tr>
        <td style="font-family:var(--font-mono);">${escapeHtml(e.request_id || "N/A")}</td>
        <td><span class="badge-method badge-DELETE">${escapeHtml(e.event_type)}</span></td>
        <td style="color:var(--accent-red);">${escapeHtml(e.error_message)}</td>
        <td>${timeStr}</td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

function formatCode(text, mime) {
  if (!text) return "";
  try {
    if (mime?.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      const parsed = JSON.parse(text);
      return JSON.stringify(parsed, null, 2);
    }
  } catch (_) {}
  return text;
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
