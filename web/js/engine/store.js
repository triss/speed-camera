// On-device observation store backed by IndexedDB.
//
// One database, one object store, indexed on [use, t] so range queries like
// "all count observations since 9am" are a single cursor scan. Falls back to
// a no-op store when IndexedDB isn't available (the app still works, it just
// doesn't persist across reloads).
//
// Storage budget: auto-rotates at MAX_STORED observations (oldest first).
// Old phones have limited quota; 10 000 tiny JSON objects is ~2–4 MB.

const DB_NAME = "lookout";
const DB_VERSION = 1;
const STORE_NAME = "observations";
const MAX_STORED = 10_000;

// ── helpers ────────────────────────────────────────────────────────────────

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore(db, mode) {
  const tx = db.transaction(STORE_NAME, mode);
  return tx.objectStore(STORE_NAME);
}

// ── open / create ──────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("use_t", ["use", "t"]);
        store.createIndex("t", "t");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── the store API ──────────────────────────────────────────────────────────

function createStore(db) {
  return {
    persistent: true,

    /** Add one observation. { use, t, …measurement }. Fire-and-forget safe. */
    async add(observation) {
      const store = txStore(db, "readwrite");
      await promisify(store.add(observation));
      // Auto-rotate: if we're over budget, trim the oldest.
      const total = await promisify(store.count());
      if (total > MAX_STORED) {
        await this._trimOldest(total - MAX_STORED);
      }
    },

    /** List observations, newest first. Options: { use, since, until, limit }. */
    async list({ use, since, until, limit } = {}) {
      const store = txStore(db, "readonly");
      const results = [];
      const max = limit || 50;

      return new Promise((resolve, reject) => {
        let cursor;
        if (use) {
          const lower = [use, since ?? 0];
          const upper = [use, until ?? Infinity];
          const range = IDBKeyRange.bound(lower, upper);
          cursor = store.index("use_t").openCursor(range, "prev");
        } else {
          if (since || until) {
            const range = IDBKeyRange.bound(since ?? 0, until ?? Infinity);
            cursor = store.index("t").openCursor(range, "prev");
          } else {
            cursor = store.index("t").openCursor(null, "prev");
          }
        }
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c && results.length < max) {
            results.push(c.value);
            c.continue();
          } else {
            resolve(results);
          }
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },

    /** Count observations. Optional { use } filter. */
    async count({ use } = {}) {
      const store = txStore(db, "readonly");
      if (use) {
        const range = IDBKeyRange.bound([use, 0], [use, Infinity]);
        return promisify(store.index("use_t").count(range));
      }
      return promisify(store.count());
    },

    /** Count per use. Returns { count: N, speed: N, … }. */
    async countByUse() {
      const store = txStore(db, "readonly");
      const out = {};
      return new Promise((resolve, reject) => {
        const cursor = store.index("use_t").openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            const use = c.value.use;
            out[use] = (out[use] || 0) + 1;
            c.continue();
          } else {
            resolve(out);
          }
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },

    /** Clear observations. Optional { use } to clear only one use. */
    async clear({ use } = {}) {
      if (!use) {
        const store = txStore(db, "readwrite");
        return promisify(store.clear());
      }
      // Delete one use at a time via cursor.
      const store = txStore(db, "readwrite");
      const range = IDBKeyRange.bound([use, 0], [use, Infinity]);
      return new Promise((resolve, reject) => {
        const cursor = store.index("use_t").openCursor(range);
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) { c.delete(); c.continue(); }
          else resolve();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },

    /** Export observations as a JSON string. Optional { use } filter. */
    async exportJSON({ use } = {}) {
      // Get all (no limit) for export.
      const store = txStore(db, "readonly");
      const results = [];
      return new Promise((resolve, reject) => {
        let cursor;
        if (use) {
          const range = IDBKeyRange.bound([use, 0], [use, Infinity]);
          cursor = store.index("use_t").openCursor(range);
        } else {
          cursor = store.index("t").openCursor();
        }
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) { results.push(c.value); c.continue(); }
          else {
            resolve(JSON.stringify({
              exported: new Date().toISOString(),
              count: results.length,
              observations: results,
            }, null, 2));
          }
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },

    /** Oldest observation timestamp, or null. */
    async oldestTimestamp() {
      const store = txStore(db, "readonly");
      return new Promise((resolve, reject) => {
        const cursor = store.index("t").openCursor(null, "next");
        cursor.onsuccess = () => {
          const c = cursor.result;
          resolve(c ? c.value.t : null);
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },

    /** Trim the N oldest observations. */
    async _trimOldest(n) {
      const store = txStore(db, "readwrite");
      let deleted = 0;
      return new Promise((resolve, reject) => {
        const cursor = store.index("t").openCursor(null, "next");
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c && deleted < n) {
            c.delete();
            deleted++;
            c.continue();
          } else {
            resolve(deleted);
          }
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },
  };
}

// ── no-op fallback ─────────────────────────────────────────────────────────

function noopStore() {
  console.warn("lookout: IndexedDB unavailable — observations will not persist.");
  return {
    persistent: false,
    add() {},
    list() { return []; },
    count() { return 0; },
    countByUse() { return {}; },
    clear() {},
    exportJSON() { return JSON.stringify({ exported: new Date().toISOString(), count: 0, observations: [] }); },
    oldestTimestamp() { return null; },
  };
}

// ── public entry point ─────────────────────────────────────────────────────

/** Open (or create) the observation store. Resolves to the store API. */
export async function openObservationStore() {
  if (typeof indexedDB === "undefined") return noopStore();
  try {
    const db = await openDB();
    return createStore(db);
  } catch (e) {
    console.error("lookout: failed to open IndexedDB:", e);
    return noopStore();
  }
}
