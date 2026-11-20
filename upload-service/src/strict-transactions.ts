import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';

/**
 * Test helper: wraps a Firestore-like client so its transactions enforce the rule the real
 * Firestore server enforces and the in-memory fake does not - every read in a transaction must
 * come before its first write ("Firestore transactions require all reads to be executed before
 * all writes"). Code that reads after writing passes against the plain fake yet fails in
 * production, so tests of transactional code run through this wrapper (KRKG-132).
 */
export function withStrictTransactionOrdering<C extends FirestoreLikeClient>(client: C): C {
  return {
    ...client,
    runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
      return client.runTransaction(async (tx) => {
        let wrote = false;
        const strict: FirestoreTransaction = {
          async getDoc<D>(collection: string, id: string) {
            if (wrote) throw new Error(`read after write in a transaction: getDoc(${collection}/${id})`);
            return tx.getDoc<D>(collection, id);
          },
          async setDoc(collection, id, data) { wrote = true; return tx.setDoc(collection, id, data); },
          async createDoc(collection, id, data) { wrote = true; return tx.createDoc(collection, id, data); },
          async deleteDoc(collection, id) { wrote = true; return tx.deleteDoc(collection, id); },
        };
        return fn(strict);
      });
    },
  };
}
