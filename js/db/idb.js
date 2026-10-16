// Minimal promise wrapper around IndexedDB.

export function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Open a database, running every migration whose version is above the stored one.
 * `migrations` is an array of {version, upgrade(db, tx)} sorted ascending.
 */
export function openDB(name, migrations, idbFactory = globalThis.indexedDB) {
  const version = migrations[migrations.length - 1].version;
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(name, version);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      for (const m of migrations) {
        if (m.version > ev.oldVersion) m.upgrade(db, tx, ev.oldVersion);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database upgrade blocked: close other tabs of this app and reload.'));
  });
}

/** Iterate a cursor; callback may return false to stop. */
export function iterate(source, range, direction, cb) {
  return new Promise((resolve, reject) => {
    const req = source.openCursor(range, direction);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      if (cb(cur.value, cur) === false) return resolve();
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
