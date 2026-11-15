/**
 * Manages CDP debugger attachment and Network domain lifecycle.
 */

import { eventCollector } from "./event-collector.js";

export class DebuggerManager {
  constructor() {
    this.attachedTabId = null;
    this.onDetachCallback = null;
  }

  async attach(tabId, onDetachCallback = null) {
    if (this.attachedTabId && this.attachedTabId !== tabId) {
      await this.detach();
    }

    this.attachedTabId = tabId;
    this.onDetachCallback = onDetachCallback;
    eventCollector.setTabId(tabId);

    const target = { tabId: tabId };

    return new Promise((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", async () => {
        if (chrome.runtime.lastError) {
          this.attachedTabId = null;
          eventCollector.setTabId(null);
          return reject(new Error(chrome.runtime.lastError.message));
        }

        try {
          // Enable Network domain with ample buffer limits for high fidelity capture
          await chrome.debugger.sendCommand(target, "Network.enable", {
            maxTotalBufferSize: 100000000, // 100 MB buffer
            maxResourceBufferSize: 25000000, // 25 MB max resource
            maxPostDataSize: 10000000, // 10 MB max POST body
          });

          resolve(true);
        } catch (err) {
          this.detach();
          reject(err);
        }
      });
    });
  }

  async detach() {
    if (!this.attachedTabId) return;

    const target = { tabId: this.attachedTabId };
    const tabId = this.attachedTabId;
    this.attachedTabId = null;
    eventCollector.setTabId(null);

    return new Promise((resolve) => {
      chrome.debugger.detach(target, () => {
        // Last error is ignored on detach
        const _ = chrome.runtime.lastError;
        resolve(true);
      });
    });
  }

  isAttached(tabId) {
    return this.attachedTabId === tabId;
  }

  getAttachedTabId() {
    return this.attachedTabId;
  }

  handleDetach(source, reason) {
    if (this.attachedTabId && source.tabId === this.attachedTabId) {
      console.log(`[DebuggerManager] Debugger detached from tab ${source.tabId}. Reason: ${reason}`);
      this.attachedTabId = null;
      eventCollector.setTabId(null);

      if (this.onDetachCallback) {
        this.onDetachCallback(source.tabId, reason);
      }
    }
  }
}

export const debuggerManager = new DebuggerManager();
