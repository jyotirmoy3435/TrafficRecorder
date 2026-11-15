/**
 * Popup UI Controller for Traffic Recorder.
 * Supports on-demand recording and standby auto-start on new tabs.
 */

let activeTab = null;
let pollTimer = null;
let recordingStartTime = null;

document.addEventListener("DOMContentLoaded", async () => {
  await initTabInfo();
  await loadSavedSettings();
  await updateStatus();

  // Set interval to update metrics and timer while popup is open
  pollTimer = setInterval(updateStatus, 1000);

  // Setup click listeners
  document.getElementById("btnToggleRecord").addEventListener("click", handleButtonClick);
  document.getElementById("btnToggleSettings").addEventListener("click", toggleSettings);
  document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);
});

function isInternalUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://")
  );
}

async function initTabInfo() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      activeTab = tabs[0];
      const title = activeTab.title || (isInternalUrl(activeTab.url) ? "New / Internal Tab" : "Untitled Tab");
      document.getElementById("tabTitle").innerText = title;
      document.getElementById("tabUrl").innerText = activeTab.url || "about:blank";
    }
  } catch (err) {
    console.error("Failed to query active tab:", err);
  }
}

async function updateStatus() {
  try {
    chrome.runtime.sendMessage({ action: "GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        return;
      }

      const { currentState, metrics, serverHealth } = response;

      // 1. Update Server Health UI
      const serverDot = document.getElementById("serverDot");
      const serverDesc = document.getElementById("serverDesc");
      if (serverHealth && serverHealth.online) {
        serverDot.className = "server-dot online";
        serverDesc.innerText = `Connected (${formatBytes(serverHealth.data.db_size_bytes)})`;
      } else {
        serverDot.className = "server-dot offline";
        serverDesc.innerText = "Offline (Run python server.py)";
      }

      // 2. State & Button Logic
      const isRec = currentState && currentState.isRecording;
      const isArmed = currentState && currentState.isArmed && (!activeTab || currentState.armedTabId === activeTab.id);
      const isInternal = isInternalUrl(activeTab ? activeTab.url : "");

      const statusIndicator = document.getElementById("statusIndicator");
      const statusLabel = document.getElementById("statusLabel");
      const btnToggle = document.getElementById("btnToggleRecord");
      const btnText = document.getElementById("btnToggleText");
      const standbyBanner = document.getElementById("standbyBanner");
      const metricsGrid = document.getElementById("metricsGrid");
      const queueStatus = document.getElementById("queueStatus");

      btnToggle.disabled = false;

      if (isRec) {
        // STATE: RECORDING
        statusIndicator.className = "status-indicator recording";
        statusLabel.innerText = "RECORDING";

        btnToggle.className = "btn btn-record btn-stop";
        btnText.innerText = "Stop Recording";

        standbyBanner.style.display = "none";
        metricsGrid.style.display = "grid";
        queueStatus.style.display = "flex";

        recordingStartTime = currentState.startedAt;
        updateTimerDisplay();

        if (metrics) {
          document.getElementById("metricRequests").innerText = metrics.requestsCaptured || 0;
          document.getElementById("metricResponses").innerText = metrics.responsesCaptured || 0;
          document.getElementById("metricWs").innerText = metrics.wsMessagesCaptured || 0;
          document.getElementById("queueCount").innerText = metrics.currentQueueLength || 0;
          document.getElementById("persistedCount").innerText = metrics.eventsPersisted || 0;
        }
      } else if (isArmed) {
        // STATE: ARMED / STANDBY
        statusIndicator.className = "status-indicator standby";
        statusLabel.innerText = "STANDBY";

        btnToggle.className = "btn btn-disarm";
        btnText.innerText = "Cancel Standby";

        standbyBanner.style.display = "flex";
        metricsGrid.style.display = "none";
        queueStatus.style.display = "none";
        recordingStartTime = null;
      } else {
        // STATE: IDLE
        statusIndicator.className = "status-indicator";
        statusLabel.innerText = "IDLE";

        standbyBanner.style.display = "none";
        metricsGrid.style.display = "none";
        queueStatus.style.display = "none";
        recordingStartTime = null;

        if (isInternal) {
          btnToggle.className = "btn btn-arm";
          btnText.innerText = "Arm on Next Navigation (Standby)";
        } else {
          btnToggle.className = "btn btn-record";
          btnText.innerText = "Start Recording This Tab";
        }
      }
    });
  } catch (err) {
    console.error("Status update error:", err);
  }
}

function updateTimerDisplay() {
  if (!recordingStartTime) return;
  const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  document.getElementById("metricElapsed").innerText = `${mm}:${ss}`;
}

async function handleButtonClick() {
  const btn = document.getElementById("btnToggleRecord");
  btn.disabled = true;

  try {
    chrome.runtime.sendMessage({ action: "GET_STATUS" }, async (res) => {
      const isRec = res && res.currentState && res.currentState.isRecording;
      const isArmed = res && res.currentState && res.currentState.isArmed;
      const isInternal = isInternalUrl(activeTab ? activeTab.url : "");

      if (isRec) {
        // Stop recording
        chrome.runtime.sendMessage({ action: "STOP_RECORDING" }, () => {
          btn.disabled = false;
          updateStatus();
        });
      } else if (isArmed) {
        // Cancel standby
        chrome.runtime.sendMessage({ action: "DISARM_RECORDING" }, () => {
          btn.disabled = false;
          updateStatus();
        });
      } else {
        if (!activeTab) {
          btn.disabled = false;
          return;
        }

        if (isInternal) {
          // Arm for standby on next navigation
          chrome.runtime.sendMessage(
            { action: "ARM_RECORDING", tab: activeTab },
            (armRes) => {
              btn.disabled = false;
              updateStatus();
            }
          );
        } else {
          // Start immediately on existing webpage
          chrome.runtime.sendMessage(
            { action: "START_RECORDING", tab: activeTab },
            (startRes) => {
              btn.disabled = false;
              if (startRes && startRes.status === "error") {
                alert("Failed to start recording:\n" + startRes.error);
              }
              updateStatus();
            }
          );
        }
      }
    });
  } catch (err) {
    btn.disabled = false;
    console.error("Button handler error:", err);
  }
}

function toggleSettings() {
  const form = document.getElementById("settingsForm");
  form.style.display = form.style.display === "none" ? "flex" : "none";
}

async function loadSavedSettings() {
  const data = await chrome.storage.local.get(["serverUrl", "apiToken"]);
  if (data.serverUrl) {
    document.getElementById("inputServerUrl").value = data.serverUrl;
    document.getElementById("linkOpenViewer").href = data.serverUrl.replace(/\/+$/, "") + "/";
  }
  if (data.apiToken) {
    document.getElementById("inputApiToken").value = data.apiToken;
  }
}

async function saveSettings() {
  const serverUrl = document.getElementById("inputServerUrl").value.trim();
  const apiToken = document.getElementById("inputApiToken").value.trim();

  await chrome.storage.local.set({ serverUrl, apiToken });
  document.getElementById("linkOpenViewer").href = serverUrl.replace(/\/+$/, "") + "/";
  document.getElementById("btnSaveSettings").innerText = "Saved!";
  setTimeout(() => {
    document.getElementById("btnSaveSettings").innerText = "Save Configuration";
    toggleSettings();
  }, 1000);
  updateStatus();
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
