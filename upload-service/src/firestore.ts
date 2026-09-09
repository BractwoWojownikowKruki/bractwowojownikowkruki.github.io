import { Firestore, FieldPath, type Query, type DocumentData } from '@google-cloud/firestore';

export interface FirestoreDoc<T> {
  id: string;
  data: T;
}

/**
 * A single equality/array-contains filter on one field, ANDed with the mandatory timestamp
 * ordering below. KRKG-0050's audit query contract allows at most one such filter per request
 * (its "zero-or-one primary selector" rule) - this type deliberately has no way to express more
 * than one, so a caller cannot accidentally build a query the contract forbids.
 */
export interface FirestoreQueryFilter {
  field: string;
  op: '==' | 'array-contains';
  value: string;
}

/**
 * Cursor position for resuming a query - the (timestamp, id) pair of the last row already
 * returned. Both fields are needed because `timestamp` alone isn't unique (two events can share
 * a millisecond); ordering secondarily by document id gives a total, stable order so pagination
 * never skips or repeats a row.
 */
export interface FirestoreQueryCursor {
  timestamp: string;
  id: string;
}

export interface FirestoreQuery {
  filter?: FirestoreQueryFilter;
  timestampField: string;
  timestampGte?: string;
  timestampLte?: string;
  startAfter?: FirestoreQueryCursor;
  limit: number;
}

/**
 * A scoped read/write handle for the duration of one `runTransaction` call - KRKG-0046. Same
 * merging-write semantics as `FirestoreLikeClient.setDoc`, just queued for atomic commit
 * alongside every other write made through this same transaction instead of applied immediately.
 */
export interface FirestoreTransaction {
  getDoc<T>(collection: string, id: string): Promise<T | null>;
  setDoc<T extends object>(collection: string, id: string, data: T): Promise<void>;
  createDoc<T extends object>(collection: string, id: string, data: T): Promise<void>;
}

export interface FirestoreLikeClient {
  getDoc<T>(collection: string, id: string): Promise<T | null>;
  /**
   * Merging write: fields absent from `data` are left untouched on an existing document
   * (Firestore's `set(..., { merge: true })`), rather than being deleted by a full-document
   * overwrite. This is the structural guarantee behind admin-only fields such as
   * `members.categoryId` and `listaWyjazdowaProfile.wpisowePaid` (design.md §7/§7a): a member's
   * self-service save simply never mentions them, so a concurrent accountant/admin edit - or an
   * admin-added field this codebase does not model at all - cannot be clobbered by it.
   */
  setDoc<T extends object>(collection: string, id: string, data: T): Promise<void>;
  /**
   * Creates an immutable document and fails if the ID already exists. Audit events use this
   * rather than merging writes so a collision or retry cannot alter prior evidence.
   */
  createDoc<T extends object>(collection: string, id: string, data: T): Promise<void>;
  listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]>;
  /**
   * Indexed, ordered, cursor-paginated query - added for KRKG-0050's audit read API, whose
   * "zero-or-one primary selector" contract (implementation-contract.md, "Query and
   * Firestore-index contract") requires the collection to never be fully scanned. Always ordered
   * by `timestampField` descending, then by document id descending as a stable tiebreak, which
   * matches the composite indexes declared in firestore.indexes.json.
   */
  queryDocs<T>(collection: string, query: FirestoreQuery): Promise<FirestoreDoc<T>[]>;
  /**
   * Read-validate-write as a single atomic unit (KRKG-0046) - required whenever a write's
   * legality depends on the document's current state (e.g. a status transition guard), so two
   * concurrent callers can't both read the same "before" state, both pass validation, and then
   * silently overwrite each other. `fn` may be invoked more than once if the underlying
   * implementation needs to retry on contention (mirrors `@google-cloud/firestore`'s own
   * `runTransaction` behavior) - keep it free of side effects beyond `tx.getDoc`/`tx.setDoc`.
   */
  runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T>;
}

export function createFirestoreClient(projectId?: string): FirestoreLikeClient {
  const db = projectId ? new Firestore({ projectId }) : new Firestore();
  return {
    async getDoc<T>(collection: string, id: string): Promise<T | null> {
      const snap = await db.collection(collection).doc(id).get();
      return snap.exists ? (snap.data() as T) : null;
    },
    async setDoc<T extends object>(collection: string, id: string, data: T): Promise<void> {
      await db.collection(collection).doc(id).set(data, { merge: true });
    },
    async createDoc<T extends object>(collection: string, id: string, data: T): Promise<void> {
      await db.collection(collection).doc(id).create(data);
    },
    async listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]> {
      const snap = await db.collection(collection).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
    },
    async queryDocs<T>(collection: string, query: FirestoreQuery): Promise<FirestoreDoc<T>[]> {
      let q: Query<DocumentData> = db.collection(collection);
      if (query.filter) q = q.where(query.filter.field, query.filter.op, query.filter.value);
      if (query.timestampGte !== undefined) q = q.where(query.timestampField, '>=', query.timestampGte);
      if (query.timestampLte !== undefined) q = q.where(query.timestampField, '<=', query.timestampLte);
      q = q.orderBy(query.timestampField, 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (query.startAfter) q = q.startAfter(query.startAfter.timestamp, query.startAfter.id);
      q = q.limit(query.limit);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
    },
    async runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
      return db.runTransaction(async transaction => {
        const tx: FirestoreTransaction = {
          async getDoc<D>(collection: string, id: string): Promise<D | null> {
            const snap = await transaction.get(db.collection(collection).doc(id));
            return snap.exists ? (snap.data() as D) : null;
          },
          async setDoc<D extends object>(collection: string, id: string, data: D): Promise<void> {
            transaction.set(db.collection(collection).doc(id), data, { merge: true });
          },
          async createDoc<D extends object>(collection: string, id: string, data: D): Promise<void> {
            transaction.create(db.collection(collection).doc(id), data);
          },
        };
        return fn(tx);
      });
    },
  };
}

export function createInMemoryFirestoreClient(): FirestoreLikeClient & {
  seed<T>(collection: string, id: string, data: T): void;
} {
  const store = new Map<string, Map<string, unknown>>();
  // See runTransaction below - chains every transaction onto this so two "concurrent" calls
  // execute one after the other, never interleaved.
  let transactionQueue: Promise<unknown> = Promise.resolve();
  const collectionMap = (collection: string) => {
    let m = store.get(collection);
    if (!m) {
      m = new Map();
      store.set(collection, m);
    }
    return m;
  };
  return {
    async getDoc<T>(collection: string, id: string): Promise<T | null> {
      const m = collectionMap(collection);
      return m.has(id) ? (m.get(id) as T) : null;
    },
    // Mirrors the real client's merge semantics so tests exercise the same behaviour production
    // gets. Firestore merges nested maps recursively and replaces arrays wholesale; none of the
    // documents this service writes nest maps (equipment/companions are arrays of flat objects),
    // so a top-level merge is faithful for every shape we actually store.
    async setDoc<T extends object>(collection: string, id: string, data: T): Promise<void> {
      const m = collectionMap(collection);
      const existing = m.get(id) as object | undefined;
      m.set(id, existing ? { ...existing, ...data } : { ...data });
    },
    async createDoc<T extends object>(collection: string, id: string, data: T): Promise<void> {
      const m = collectionMap(collection);
      if (m.has(id)) throw new Error(`Document already exists: ${collection}/${id}`);
      m.set(id, { ...data });
    },
    async listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]> {
      const m = collectionMap(collection);
      return Array.from(m.entries()).map(([id, data]) => ({ id, data: data as T }));
    },
    // Mirrors the production client's ordering/filter/cursor semantics (see queryDocs above) over
    // the in-memory Map, so a test exercising the audit query module gets the same observable
    // behaviour production Firestore does, including the timestamp-desc/id-desc tiebreak order.
    async queryDocs<T>(collection: string, query: FirestoreQuery): Promise<FirestoreDoc<T>[]> {
      const m = collectionMap(collection);
      const getField = (data: unknown, field: string): unknown =>
        field.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), data);
      let rows = Array.from(m.entries()).map(([id, data]) => ({ id, data: data as T }));
      if (query.filter) {
        const { field, op, value } = query.filter;
        rows = rows.filter(row => {
          const actual = getField(row.data, field);
          if (op === '==') return actual === value;
          return Array.isArray(actual) && actual.includes(value);
        });
      }
      if (query.timestampGte !== undefined) {
        rows = rows.filter(row => String(getField(row.data, query.timestampField)) >= query.timestampGte!);
      }
      if (query.timestampLte !== undefined) {
        rows = rows.filter(row => String(getField(row.data, query.timestampField)) <= query.timestampLte!);
      }
      rows.sort((a, b) => {
        const ta = String(getField(a.data, query.timestampField));
        const tb = String(getField(b.data, query.timestampField));
        if (ta !== tb) return ta < tb ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      if (query.startAfter) {
        const { timestamp, id } = query.startAfter;
        const startIndex = rows.findIndex(row => {
          const t = String(getField(row.data, query.timestampField));
          if (t !== timestamp) return t < timestamp;
          return row.id < id;
        });
        rows = startIndex === -1 ? [] : rows.slice(startIndex);
      }
      return rows.slice(0, query.limit);
    },
    // Test-setup escape hatch: replaces the document wholesale (no merge), so a test can state
    // the exact stored shape it wants to start from.
    seed<T>(collection: string, id: string, data: T): void {
      collectionMap(collection).set(id, data);
    },
    // Serializes every transaction through one global queue, so a test's two "concurrent"
    // calls (e.g. via Promise.allSettled) actually run one after the other rather than
    // interleaving - the same observable guarantee real Firestore gives via per-document
    // contention + automatic retry, without needing to implement retry-on-conflict here. Writes
    // are buffered and only applied to the store if `fn` resolves, matching real Firestore's
    // commit-on-success/discard-on-throw transaction semantics.
    async runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const pendingWrites = new Map<string, { collection: string; id: string; data: object }>();
        const tx: FirestoreTransaction = {
          async getDoc<D>(collection: string, id: string): Promise<D | null> {
            const m = collectionMap(collection);
            return m.has(id) ? (m.get(id) as D) : null;
          },
          async setDoc<D extends object>(collection: string, id: string, data: D): Promise<void> {
            // JSON-encoded tuple, not a delimited template string - avoids relying on any
            // separator character being absent from collection/id values. A prior revision
            // of this line accidentally contained a literal NUL byte, which made Git treat
            // this whole source file as binary and suppress normal diffs on it.
            const key = JSON.stringify([collection, id]);
            const base = pendingWrites.get(key)?.data ?? (collectionMap(collection).get(id) as object | undefined);
            pendingWrites.set(key, { collection, id, data: base ? { ...base, ...data } : { ...data } });
          },
          async createDoc<D extends object>(collection: string, id: string, data: D): Promise<void> {
            const key = JSON.stringify([collection, id]);
            if (pendingWrites.has(key) || collectionMap(collection).has(id)) {
              throw new Error(`Document already exists: ${collection}/${id}`);
            }
            pendingWrites.set(key, { collection, id, data: { ...data } });
          },
        };
        const result = await fn(tx);
        for (const { collection, id, data } of pendingWrites.values()) {
          collectionMap(collection).set(id, data);
        }
        return result;
      };
      const result = transactionQueue.then(run, run);
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
