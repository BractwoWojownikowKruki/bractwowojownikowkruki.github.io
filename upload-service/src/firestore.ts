import { Firestore } from '@google-cloud/firestore';

export interface FirestoreDoc<T> {
  id: string;
  data: T;
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
  listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]>;
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
    async listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]> {
      const snap = await db.collection(collection).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
    },
  };
}

export function createInMemoryFirestoreClient(): FirestoreLikeClient & {
  seed<T>(collection: string, id: string, data: T): void;
} {
  const store = new Map<string, Map<string, unknown>>();
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
    async listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]> {
      const m = collectionMap(collection);
      return Array.from(m.entries()).map(([id, data]) => ({ id, data: data as T }));
    },
    // Test-setup escape hatch: replaces the document wholesale (no merge), so a test can state
    // the exact stored shape it wants to start from.
    seed<T>(collection: string, id: string, data: T): void {
      collectionMap(collection).set(id, data);
    },
  };
}
