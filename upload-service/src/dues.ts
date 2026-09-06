import type { FirestoreLikeClient } from './firestore.ts';

export interface DuesDoc {
  email: string;
  year: number;
  paid: boolean;
  updatedBy: string;
  updatedAt: string;
}

const COLLECTION = 'duesAnnual';

function duesId(email: string, year: number): string {
  return `${email.toLowerCase()}_${year}`;
}

export async function getDues(client: FirestoreLikeClient, email: string, year: number): Promise<DuesDoc | null> {
  return client.getDoc<DuesDoc>(COLLECTION, duesId(email, year));
}

export async function listDuesForYear(client: FirestoreLikeClient, year: number): Promise<DuesDoc[]> {
  const all = await client.listDocs<DuesDoc>(COLLECTION);
  return all.map((d) => d.data).filter((d) => d.year === year);
}

export async function setDuesPaid(
  client: FirestoreLikeClient,
  email: string,
  year: number,
  paid: boolean,
  updatedBy: string,
): Promise<DuesDoc> {
  const id = duesId(email, year);
  const doc: DuesDoc = {
    email: email.toLowerCase(),
    year,
    paid,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await client.setDoc(COLLECTION, id, doc);
  return doc;
}
