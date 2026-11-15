/**
 * API client to communicate with the local Traffic Recorder Companion Server.
 */

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";

export class ApiClient {
  constructor() {
    this.serverUrl = DEFAULT_SERVER_URL;
    this.apiToken = "";
    this.loadSettings();
  }

  async loadSettings() {
    try {
      const data = await chrome.storage.local.get(["serverUrl", "apiToken"]);
      if (data.serverUrl) this.serverUrl = data.serverUrl.replace(/\/+$/, "");
      if (data.apiToken) this.apiToken = data.apiToken;
    } catch (_) {}
  }

  getHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    return headers;
  }

  async checkHealth() {
    await this.loadSettings();
    try {
      const resp = await fetch(`${this.serverUrl}/api/v1/health`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (resp.ok) {
        return { online: true, data: await resp.json() };
      }
      return { online: false, error: `HTTP ${resp.status}` };
    } catch (err) {
      return { online: false, error: err.message || "Failed to fetch" };
    }
  }

  async startSession({ sessionId, tabId, initialUrl, title, startedAt }) {
    await this.loadSettings();
    try {
      const resp = await fetch(`${this.serverUrl}/api/v1/session/start`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          session_id: sessionId,
          tab_id: tabId,
          initial_url: initialUrl,
          title: title,
          started_at: startedAt || Date.now(),
        }),
      });
      return await resp.json();
    } catch (err) {
      console.error("[ApiClient] startSession failed:", err);
      return { status: "error", message: err.message };
    }
  }

  async stopSession({ sessionId, endedAt, stats }) {
    await this.loadSettings();
    try {
      const resp = await fetch(`${this.serverUrl}/api/v1/session/stop`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          session_id: sessionId,
          ended_at: endedAt || Date.now(),
          stats: stats || {},
        }),
      });
      return await resp.json();
    } catch (err) {
      console.error("[ApiClient] stopSession failed:", err);
      return { status: "error", message: err.message };
    }
  }

  async ingestBatch({ sessionId, events }) {
    if (!events || events.length === 0) return { status: "ok", processed_count: 0 };
    await this.loadSettings();
    try {
      const resp = await fetch(`${this.serverUrl}/api/v1/ingest`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          session_id: sessionId,
          events: events,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Server returned HTTP ${resp.status}`);
      }
      return await resp.json();
    } catch (err) {
      console.error("[ApiClient] ingestBatch failed:", err);
      return { status: "error", message: err.message };
    }
  }
}

export const apiClient = new ApiClient();
