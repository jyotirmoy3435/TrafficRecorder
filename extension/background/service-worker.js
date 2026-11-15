/**
 * Background Service Worker for Traffic Recorder.
 * Manifest V3 entrypoint with standby / armed auto-start capabilities.
 */

import { apiClient } from "./api-client.js";
import { debuggerManager } from "./debugger-manager.js";
import { eventCollector } from "./event-collector.js";
import { queueManager } from "./queue-manager.js";

// Session state
let currentState = {
  isRecording: false,
  isArmed: false,
  armedTabId: null,
  activeTabId: null,
  sessionId: null,
  startedAt: null,
  initialUrl: null,
  title: null,
};

let isStartingSession = false;

// Generate random UUID
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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

// Restore state from storage on startup / wake
async function restoreState() {
  try {
    const stored = await chrome.storage.local.get("recordingState");
    if (stored.recordingState) {
      currentState = { ...currentState, ...stored.recordingState };
      if (currentState.isRecording && currentState.activeTabId) {
        chrome.tabs.get(currentState.activeTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            stopRecording();
          } else {
            queueManager.init(currentState.sessionId);
            eventCollector.setTabId(currentState.activeTabId);
          }
        });
      } else if (currentState.isArmed && currentState.armedTabId) {
        chrome.tabs.get(currentState.armedTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            disarmRecording();
          }
        });
      }
    }
  } catch (_) {}
}

async function persistState() {
  await chrome.storage.local.set({ recordingState: currentState });
}

// Setup CDP listeners
chrome.debugger.onEvent.addListener((source, method, params) => {
  eventCollector.handleCdpEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  debuggerManager.handleDetach(source, reason);
});

// Tab closed listener
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentState.isRecording && currentState.activeTabId === tabId) {
    console.log(`[ServiceWorker] Recorded tab ${tabId} was closed. Finalizing session.`);
    stopRecording();
  } else if (currentState.isArmed && currentState.armedTabId === tabId) {
    console.log(`[ServiceWorker] Armed tab ${tabId} was closed. Canceling standby.`);
    disarmRecording();
  }
});

// Standby / Arming navigation listener (earliest possible event)
if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (
      currentState.isArmed &&
      details.tabId === currentState.armedTabId &&
      details.frameId === 0 &&
      !isInternalUrl(details.url)
    ) {
      console.log(`[ServiceWorker] Standby triggered for armed tab ${details.tabId} on navigation to ${details.url}`);
      try {
        const tab = await chrome.tabs.get(details.tabId);
        tab.url = details.url;
        await triggerArmedRecording(tab);
      } catch (e) {
        console.error("[ServiceWorker] Failed to trigger armed recording on navigation:", e);
      }
    }
  });
}

// Fallback tab update listener
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (
    currentState.isArmed &&
    tabId === currentState.armedTabId &&
    (changeInfo.url || changeInfo.status === "loading") &&
    tab.url &&
    !isInternalUrl(tab.url)
  ) {
    console.log(`[ServiceWorker] Standby triggered via tabs.onUpdated for tab ${tabId}: ${tab.url}`);
    await triggerArmedRecording(tab);
  } else if (currentState.isRecording && tabId === currentState.activeTabId && tab.title) {
    currentState.title = tab.title;
  }
});

async function triggerArmedRecording(tab) {
  if (isStartingSession || currentState.isRecording) return;
  currentState.isArmed = false;
  currentState.armedTabId = null;
  await startRecording(tab);
}

function armRecording(tab) {
  currentState.isArmed = true;
  currentState.armedTabId = tab.id;
  currentState.isRecording = false;
  currentState.activeTabId = null;
  currentState.initialUrl = tab.url;
  currentState.title = tab.title;

  chrome.action.setBadgeText({ text: "ARM" });
  chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }); // Amber

  persistState();
  return { status: "armed", armedTabId: tab.id };
}

function disarmRecording() {
  currentState.isArmed = false;
  currentState.armedTabId = null;

  if (!currentState.isRecording) {
    chrome.action.setBadgeText({ text: "" });
  }

  persistState();
  return { status: "idle" };
}

async function startRecording(tab) {
  if (isStartingSession) return { status: "starting" };
  isStartingSession = true;

  if (currentState.isRecording) {
    if (currentState.activeTabId === tab.id) {
      isStartingSession = false;
      return { status: "already_recording", currentState };
    }
    await stopRecording();
  }

  // Clear any armed state
  currentState.isArmed = false;
  currentState.armedTabId = null;

  const sessionId = generateUUID();
  const now = Date.now();

  try {
    // 1. Notify Python Server
    await apiClient.startSession({
      sessionId: sessionId,
      tabId: tab.id,
      initialUrl: tab.url,
      title: tab.title,
      startedAt: now,
    });

    // 2. Initialize Queue Manager
    queueManager.init(sessionId);

    // 3. Attach Chrome Debugger
    await debuggerManager.attach(tab.id, (tabId, reason) => {
      console.warn(`[ServiceWorker] Debugger detached by user/browser for tab ${tabId}: ${reason}`);
      stopRecording();
    });

    // 4. Update and persist state
    currentState = {
      isRecording: true,
      isArmed: false,
      armedTabId: null,
      activeTabId: tab.id,
      sessionId: sessionId,
      startedAt: now,
      initialUrl: tab.url,
      title: tab.title,
    };
    await persistState();

    // Set extension badge
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }); // Red

    return { status: "success", currentState };
  } catch (err) {
    console.error("[ServiceWorker] Failed to start recording:", err);
    await stopRecording();
    return { status: "error", error: err.message };
  } finally {
    isStartingSession = false;
  }
}

async function stopRecording() {
  if (!currentState.isRecording && !debuggerManager.getAttachedTabId()) {
    currentState.isArmed = false;
    currentState.armedTabId = null;
    chrome.action.setBadgeText({ text: "" });
    await persistState();
    return { status: "not_recording" };
  }

  const sid = currentState.sessionId;
  const metrics = queueManager.getMetrics();

  try {
    // 1. Detach debugger immediately
    await debuggerManager.detach();

    // 2. Flush all remaining queued events to the server
    await queueManager.flushAll();

    // 3. Inform server that session ended
    if (sid) {
      await apiClient.stopSession({
        sessionId: sid,
        endedAt: Date.now(),
        stats: metrics,
      });
    }
  } catch (err) {
    console.error("[ServiceWorker] Error during recording teardown:", err);
  } finally {
    currentState = {
      isRecording: false,
      isArmed: false,
      armedTabId: null,
      activeTabId: null,
      sessionId: null,
      startedAt: null,
      initialUrl: null,
      title: null,
    };
    await persistState();

    chrome.action.setBadgeText({ text: "" });
  }

  return { status: "stopped", stats: metrics };
}

// Runtime message dispatcher for popup UI
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request.action;

  if (action === "GET_STATUS") {
    apiClient.checkHealth().then((health) => {
      sendResponse({
        currentState,
        metrics: queueManager.getMetrics(),
        serverHealth: health,
      });
    });
    return true; // Keep message channel open for async response
  }

  if (action === "ARM_RECORDING") {
    const res = armRecording(request.tab);
    sendResponse(res);
    return false;
  }

  if (action === "DISARM_RECORDING") {
    const res = disarmRecording();
    sendResponse(res);
    return false;
  }

  if (action === "START_RECORDING") {
    startRecording(request.tab).then((res) => sendResponse(res));
    return true;
  }

  if (action === "STOP_RECORDING") {
    stopRecording().then((res) => sendResponse(res));
    return true;
  }

  if (action === "CHECK_SERVER") {
    apiClient.checkHealth().then((res) => sendResponse(res));
    return true;
  }
});

// Initialize on load
restoreState();
