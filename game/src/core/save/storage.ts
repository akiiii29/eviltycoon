/** Where save text lives. IndexedDB in the browser; memory in tests. Cloud save plugs in here later. */
export interface SaveStorage {
  read(slot: string): Promise<string | null>;
  write(slot: string, text: string): Promise<void>;
  remove(slot: string): Promise<void>;
}

export class MemoryStorage implements SaveStorage {
  private map = new Map<string, string>();
  async read(slot: string) {
    return this.map.get(slot) ?? null;
  }
  async write(slot: string, text: string) {
    this.map.set(slot, text);
  }
  async remove(slot: string) {
    this.map.delete(slot);
  }
}

const DB_NAME = 'town-hunter';
const STORE = 'saves';

export class IndexedDbStorage implements SaveStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly idb: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = this.idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async read(slot: string): Promise<string | null> {
    const v = await this.run('readonly', (s) => s.get(slot));
    return typeof v === 'string' ? v : null;
  }

  async write(slot: string, text: string): Promise<void> {
    await this.run('readwrite', (s) => s.put(text, slot));
  }

  async remove(slot: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(slot));
  }
}
