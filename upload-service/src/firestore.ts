import { Firestore } from '@google-cloud/firestore';

export interface FirestoreDoc<T> {
  id: string;
  data: T;
}

export interface FirestoreLikeClient {
  getDoc<T>(collection: string, id: string): Promise<T | null>;
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
      await db.collection(collection).doc(id).set(data);
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
    async setDoc<T extends object>(collection: string, id: string, data: T): Promise<void> {
      collectionMap(collection).set(id, data);
    },
    async listDocs<T>(collection: string): Promise<FirestoreDoc<T>[]> {
      const m = collectionMap(collection);
      return Array.from(m.entries()).map(([id, data]) => ({ id, data: data as T }));
    },
    seed<T>(collection: string, id: string, data: T): void {
      collectionMap(collection).set(id, data);
    },
  };
}
