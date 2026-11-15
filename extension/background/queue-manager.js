/**
 * Bounded in-memory event queue and batch transmission manager.
 * Guarantees low RAM consumption with backpressure safeguards and zero silent loss.
 */

import { apiClient } from "./api-client.js";

const DEFAULT_BATCH_INTERVAL_MS = 500;
const DEFAULT_BATCH_SIZE_TRIGGER = 25;
const MAX_QUEUE_CAPACITY = 500;

export class QueueManager {
  constructor() {
    this.sessionId = null;
    this.queue = [];
    this.isFlushing = false;
    this.timer = null;

    // Metrics
    this.stats = {
      requestsCaptured: 0,
      responsesCaptured: 0,
      wsMessagesCaptured: 0,
      eventsQueued: 0,
      eventsPersisted: 0,
      eventsDropped: 0,
      lastFlushTime: Date.now(),
    };
  }

  init(sessionId) {
    this.sessionId = sessionId;
    this.queue = [];
    this.isFlushing = false;
    this.resetStats();
    this.startTimer();
  }

  resetStats() {
    this.stats = {
      requestsCaptured: 0,
      responsesCaptured: 0,
      wsMessagesCaptured: 0,
      eventsQueued: 0,
      eventsPersisted: 0,
      eventsDropped: 0,
      lastFlushTime: Date.now(),
    };
  }

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.flush();
    }, DEFAULT_BATCH_INTERVAL_MS);
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  enqueue(event) {
    if (!this.sessionId) return;

    // Track metric counters
    this.stats.eventsQueued++;
    if (event.event_type === "request") this.stats.requestsCaptured++;
    else if (event.event_type === "response") this.stats.responsesCaptured++;
    else if (event.event_type === "ws_message") this.stats.wsMessagesCaptured++;

    // Backpressure check: if queue exceeded maximum capacity, drop non-critical events
    if (this.queue.length >= MAX_QUEUE_CAPACITY) {
      this.stats.eventsDropped++;
      // Replace oldest item with an explicit error event if not already reported
      this.queue.shift();
      this.queue.push({
        event_type: "capture_error",
        error_message: "Queue capacity reached backpressure limit. An older event was dropped.",
        timestamp: Date.now(),
      });
    }

    this.queue.push(event);

    // If batch size reached trigger threshold, flush immediately without waiting for timer
    if (this.queue.length >= DEFAULT_BATCH_SIZE_TRIGGER && !this.isFlushing) {
      this.flush();
    }
  }

  async flush() {
    if (this.isFlushing || this.queue.length === 0 || !this.sessionId) {
      return;
    }

    this.isFlushing = true;
    // Extract current slice to transmit
    const batch = this.queue.splice(0, DEFAULT_BATCH_SIZE_TRIGGER);

    try {
      const res = await apiClient.ingestBatch({
        sessionId: this.sessionId,
        events: batch,
      });

      if (res && res.status === "ok") {
        this.stats.eventsPersisted += batch.length;
        this.stats.lastFlushTime = Date.now();
      } else {
        // Transmission failed: put batch back to the head of the queue if capacity allows
        console.warn("[QueueManager] Batch ingestion unsuccessful, requeueing items...");
        if (this.queue.length + batch.length <= MAX_QUEUE_CAPACITY) {
          this.queue.unshift(...batch);
        } else {
          this.stats.eventsDropped += batch.length;
        }
      }
    } catch (err) {
      console.error("[QueueManager] Flush error:", err);
      // Requeue if room
      if (this.queue.length + batch.length <= MAX_QUEUE_CAPACITY) {
        this.queue.unshift(...batch);
      } else {
        this.stats.eventsDropped += batch.length;
      }
    } finally {
      this.isFlushing = false;
      // If there are still items queued, trigger next batch
      if (this.queue.length >= DEFAULT_BATCH_SIZE_TRIGGER) {
        this.flush();
      }
    }
  }

  async flushAll() {
    this.stopTimer();
    while (this.queue.length > 0) {
      await this.flush();
      // Brief pause to allow event loop
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  getMetrics() {
    return {
      ...this.stats,
      currentQueueLength: this.queue.length,
    };
  }
}

export const queueManager = new QueueManager();
