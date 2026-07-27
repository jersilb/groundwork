// Phase 3 resilience prototype — NOT the production client. Demonstrates
// and lets us test the mechanism the build plan requires (§3.3): IndexedDB
// local mirror, offline submit/vote queue with client-generated UUIDs,
// replay on reconnect, per-field vector-timestamp vote reconciliation.
// The real shared-screen/phone UI is frontend-ux-engineer's job, governed
// by ultimate-web-designer — this file exists only so scripts/test-phase3-
// resilience.mjs can drive a real browser against a real SessionDO.

const DB_NAME = "groundwork-resilience-test";
const STORE_STATE = "state";
const STORE_QUEUE = "queue";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_QUEUE)) db.createObjectStore(STORE_QUEUE, { keyPath: "uuid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    if (store === STORE_QUEUE) tx.objectStore(store).put(value);
    else tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class ResilientClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.db = null;
    this.logicalClock = 0;
    this.latestState = null;
    this.connected = false;
    this.voterUuid = null;
  }

  async init() {
    this.db = await openDb();
    const mirrored = await idbGet(this.db, STORE_STATE, "latest");
    if (mirrored) this.latestState = mirrored;
    this.connect();
  }

  connect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("open", () => {
      this.connected = true;
      this.flushQueue();
    });
    this.ws.addEventListener("close", () => {
      this.connected = false;
      if (!this._stopped) {
        this._reconnectTimer = setTimeout(() => this.connect(), 300);
      }
    });
    this.ws.addEventListener("message", async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        this.latestState = msg.state;
        await idbPut(this.db, STORE_STATE, "latest", msg.state);
        await this.reconcileQueue(msg.state);
      }
    });
  }

  /** Queue-then-send: the message lands in IndexedDB first, so it survives
   * a page reload while offline, then we attempt to send immediately if
   * connected. If not connected, it just waits in the queue for flush(). */
  async enqueue(message) {
    const uuid = message.clientUuid ?? message.voterUuid;
    await idbPut(this.db, STORE_QUEUE, null, { uuid, message, queuedAt: Date.now() });
    this.trySend(message);
  }

  trySend(message) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  async flushQueue() {
    const items = await idbGetAll(this.db, STORE_QUEUE);
    for (const item of items) {
      this.ws.send(JSON.stringify(item.message));
    }
  }

  /** Removes queued items once the server's broadcast state confirms they
   * were applied — confirmation, not "send() didn't throw", is what proves
   * delivery over a flaky connection. */
  async reconcileQueue(state) {
    const items = await idbGetAll(this.db, STORE_QUEUE);
    for (const item of items) {
      const m = item.message;
      let applied = false;
      if (m.type === "submit") {
        applied = (state.submittedClientUuids[m.segmentKey] ?? []).includes(m.clientUuid);
      } else if (m.type === "vote") {
        const v = state.votes?.[m.segmentKey]?.[m.voterUuid];
        applied = Boolean(v && v.logicalClock >= m.logicalClock);
      }
      if (applied) await idbDelete(this.db, STORE_QUEUE, item.uuid);
    }
  }

  async submit(segmentKey, content) {
    const clientUuid = crypto.randomUUID();
    await this.enqueue({ type: "submit", segmentKey, clientUuid, content });
    return clientUuid;
  }

  async vote(segmentKey, optionId) {
    this.logicalClock += 1;
    if (!this.voterUuid) this.voterUuid = crypto.randomUUID();
    await this.enqueue({
      type: "vote",
      segmentKey,
      optionId,
      voterUuid: this.voterUuid,
      logicalClock: this.logicalClock,
    });
  }

  async pendingCount() {
    const items = await idbGetAll(this.db, STORE_QUEUE);
    return items.length;
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this.ws?.close();
  }
}

window.ResilientClient = ResilientClient;
