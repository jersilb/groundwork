// Durable offline outbox for session input (Phase 3 resilience).
// IndexedDB-backed queue of submissions/votes/advances so a phone keeps
// working with the network cut. The SessionSocket outbox handles the
// in-memory gap; this store survives reloads and is drained on reconnect.

const DB_NAME = "groundwork-offline";
const DB_VERSION = 1;
const STORE = "outbox";

export interface QueuedEntry {
  id?: number;
  /** Only "submit" and "vote" are safe to replay after a reload — the
   * server dedups submissions by clientUuid and reconciles votes by
   * logicalClock. "advance" is NOT idempotent and must never be replayed
   * from this store (SessionSocket never enqueues it durably). */
  kind: "submit" | "vote" | "advance";
  clientUuid: string;
  /** The session this entry belongs to — entries are only drained into
   * the socket for their own session (one phone, many sessions). */
  sessionKey?: string;
  segmentKey?: string;
  payload?: unknown;
  logicalClock: number;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const request = fn(t.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export interface Clock {
  now(): number;
}

let logicalClock = 0;
const CLOCK_KEY = "groundwork.logicalClock";

export function loadClock(): number {
  const raw = localStorage.getItem(CLOCK_KEY);
  logicalClock = raw ? Number(raw) || 0 : 0;
  return logicalClock;
}

export function nextClock(): number {
  logicalClock += 1;
  localStorage.setItem(CLOCK_KEY, String(logicalClock));
  return logicalClock;
}

/** Persist one outbound message for later replay. Resolves with its id. */
export function enqueue(entry: Omit<QueuedEntry, "id" | "createdAt" | "logicalClock"> & { logicalClock?: number }): Promise<number> {
  const full: QueuedEntry = {
    ...entry,
    logicalClock: entry.logicalClock ?? nextClock(),
    createdAt: Date.now(),
  };
  return tx("readwrite", (store) => store.add(full)) as Promise<number>;
}

/** All pending entries, oldest first. */
export async function getPending(): Promise<QueuedEntry[]> {
  const all = (await tx("readonly", (store) => store.getAll())) as QueuedEntry[];
  return all.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/**
 * Try to deliver every pending entry through sendFn. Entries that deliver
 * are removed; the first delivery failure stops the drain and its entry is
 * kept (the caller decides whether to retry later). Returns the number of
 * entries successfully drained.
 */
export async function drain(sendFn: (entry: QueuedEntry) => Promise<void> | void): Promise<number> {
  const pending = await getPending();
  let drained = 0;
  for (const entry of pending) {
    try {
      await sendFn(entry);
    } catch {
      break; // keep this and every later entry queued
    }
    await remove(entry.id as number);
    drained += 1;
  }
  return drained;
}

export function remove(id: number): Promise<unknown> {
  return tx("readwrite", (store) => store.delete(id));
}

export function clearAll(): Promise<unknown> {
  return tx("readwrite", (store) => store.clear());
}
