/**
 * Normalizes Chrome DevTools Protocol (CDP) Network domain events
 * into clean structured payloads for queueing and persistence.
 */

import { queueManager } from "./queue-manager.js";

export class EventCollector {
  constructor() {
    this.tabId = null;
    // Map of pending request bodies and metadata
    this.pendingRequests = new Map();
  }

  setTabId(tabId) {
    this.tabId = tabId;
    this.pendingRequests.clear();
  }

  handleCdpEvent(source, method, params) {
    if (!this.tabId || source.tabId !== this.tabId) {
      return;
    }

    try {
      switch (method) {
        case "Network.requestWillBeSent":
          this.handleRequestWillBeSent(params);
          break;

        case "Network.requestWillBeSentExtraInfo":
          this.handleRequestExtraInfo(params);
          break;

        case "Network.responseReceived":
          this.handleResponseReceived(params);
          break;

        case "Network.responseReceivedExtraInfo":
          this.handleResponseExtraInfo(params);
          break;

        case "Network.loadingFinished":
          this.handleLoadingFinished(params);
          break;

        case "Network.loadingFailed":
          this.handleLoadingFailed(params);
          break;

        case "Network.webSocketCreated":
          this.handleWebSocketCreated(params);
          break;

        case "Network.webSocketWillSendHandshakeRequest":
          this.handleWebSocketHandshakeRequest(params);
          break;

        case "Network.webSocketHandshakeResponseReceived":
          this.handleWebSocketHandshakeResponse(params);
          break;

        case "Network.webSocketFrameSent":
          this.handleWebSocketFrame(params, "sent");
          break;

        case "Network.webSocketFrameReceived":
          this.handleWebSocketFrame(params, "received");
          break;

        case "Network.webSocketFrameError":
          this.handleWebSocketFrameError(params);
          break;

        case "Network.webSocketClosed":
          this.handleWebSocketClosed(params);
          break;

        default:
          break;
      }
    } catch (err) {
      console.error("[EventCollector] Exception in handling CDP event:", method, err);
    }
  }

  handleRequestWillBeSent(params) {
    const req = params.request;
    const reqId = params.requestId;
    const now = params.wallTime ? Math.round(params.wallTime * 1000) : Date.now();

    // Handle HTTP redirect chain: if redirectResponse exists, record it as a response first
    if (params.redirectResponse) {
      const red = params.redirectResponse;
      queueManager.enqueue({
        event_type: "response",
        request_id: reqId,
        status_code: red.status,
        status_text: red.statusText || "Redirect",
        mime_type: red.mimeType || "",
        protocol: red.protocol || "",
        from_cache: red.fromDiskCache || red.fromServiceWorker || false,
        headers: red.headers || {},
        timestamp: now,
      });
    }

    const event = {
      event_type: "request",
      request_id: reqId,
      url: req.url,
      method: req.method,
      resource_type: params.type || "Other",
      headers: req.headers || {},
      post_data: req.postData || null,
      post_data_base64: false,
      timestamp: now,
    };

    // If request has post data that wasn't included in the event, fetch it
    if (req.hasPostData && !req.postData && this.tabId) {
      chrome.debugger.sendCommand(
        { tabId: this.tabId },
        "Network.getRequestPostData",
        { requestId: reqId },
        (res) => {
          if (!chrome.runtime.lastError && res && res.postData) {
            event.post_data = res.postData;
          }
          queueManager.enqueue(event);
        }
      );
    } else {
      queueManager.enqueue(event);
    }
  }

  handleRequestExtraInfo(params) {
    // Optionally update raw request headers if needed
  }

  handleResponseReceived(params) {
    const resp = params.response;
    const reqId = params.requestId;
    const now = Date.now();

    this.pendingRequests.set(reqId, {
      mimeType: resp.mimeType,
      url: resp.url,
    });

    queueManager.enqueue({
      event_type: "response",
      request_id: reqId,
      status_code: resp.status,
      status_text: resp.statusText || "",
      mime_type: resp.mimeType || "",
      protocol: resp.protocol || "",
      from_cache: resp.fromDiskCache || resp.fromServiceWorker || false,
      headers: resp.headers || {},
      timestamp: now,
    });
  }

  handleResponseExtraInfo(params) {
    // Extra raw response headers
  }

  handleLoadingFinished(params) {
    const reqId = params.requestId;
    if (!this.tabId) return;

    const meta = this.pendingRequests.get(reqId) || {};

    // Fetch response body from CDP
    chrome.debugger.sendCommand(
      { tabId: this.tabId },
      "Network.getResponseBody",
      { requestId: reqId },
      (result) => {
        if (chrome.runtime.lastError) {
          // Response body unavailable (e.g. 204 No Content, 304 Not Modified, cached, or purged)
          this.pendingRequests.delete(reqId);
          return;
        }

        if (result && result.body !== undefined) {
          queueManager.enqueue({
            event_type: "response_body",
            request_id: reqId,
            body: result.body,
            base64_encoded: result.base64Encoded || false,
            mime_type: meta.mimeType || "",
            timestamp: Date.now(),
          });
        }
        this.pendingRequests.delete(reqId);
      }
    );
  }

  handleLoadingFailed(params) {
    queueManager.enqueue({
      event_type: "error",
      request_id: params.requestId,
      sub_type: "Network.loadingFailed",
      error_message: params.errorText || (params.canceled ? "Canceled" : "Network error"),
      timestamp: Date.now(),
    });
    this.pendingRequests.delete(params.requestId);
  }

  handleWebSocketCreated(params) {
    queueManager.enqueue({
      event_type: "ws_created",
      request_id: params.requestId,
      url: params.url,
      timestamp: Date.now(),
    });
  }

  handleWebSocketHandshakeRequest(params) {
    // Upgrade request headers
  }

  handleWebSocketHandshakeResponse(params) {
    // Upgrade response headers
  }

  handleWebSocketFrame(params, direction) {
    const frame = params.response || {};
    queueManager.enqueue({
      event_type: "ws_message",
      request_id: params.requestId,
      direction: direction,
      opcode: frame.opcode !== undefined ? frame.opcode : 1,
      is_binary: frame.opcode === 2,
      payload_data: frame.payloadData || "",
      base64_encoded: frame.opcode === 2,
      timestamp: Date.now(),
    });
  }

  handleWebSocketFrameError(params) {
    queueManager.enqueue({
      event_type: "error",
      request_id: params.requestId,
      sub_type: "Network.webSocketFrameError",
      error_message: params.errorMessage || "WebSocket frame error",
      timestamp: Date.now(),
    });
  }

  handleWebSocketClosed(params) {
    queueManager.enqueue({
      event_type: "ws_closed",
      request_id: params.requestId,
      timestamp: Date.now(),
    });
  }
}

export const eventCollector = new EventCollector();
