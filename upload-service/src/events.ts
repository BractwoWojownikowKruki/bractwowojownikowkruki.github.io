import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

export interface EventDoc {
  name: string;
  startDate: string; // YYYY-MM-DD
  status: 'active' | 'cancelled';
  createdBy: string;
  createdAt: string;
}

export interface EventWithId extends EventDoc {
  id: string;
}

export interface EventWritableFields {
  name?: string;
  startDate?: string;
  status?: 'active' | 'cancelled';
}

const COLLECTION = 'events';

export async function listEvents(client: FirestoreLikeClient): Promise<EventWithId[]> {
  const docs = await client.listDocs<EventDoc>(COLLECTION);
  return docs.map((d) => ({ id: d.id, ...d.data }));
}

export async function getEvent(client: FirestoreLikeClient, eventId: string): Promise<EventWithId | null> {
  const doc = await client.getDoc<EventDoc>(COLLECTION, eventId);
  return doc ? { id: eventId, ...doc } : null;
}

export async function createEvent(
  client: FirestoreLikeClient,
  fields: { name: string; startDate: string },
  createdBy: string,
): Promise<EventWithId> {
  const id = randomUUID();
  const doc: EventDoc = {
    name: fields.name,
    startDate: fields.startDate,
    status: 'active',
    createdBy,
    createdAt: new Date().toISOString(),
  };
  await client.setDoc(COLLECTION, id, doc);
  return { id, ...doc };
}

export async function updateEvent(
  client: FirestoreLikeClient,
  eventId: string,
  fields: EventWritableFields,
): Promise<EventWithId | null> {
  const existing = await client.getDoc<EventDoc>(COLLECTION, eventId);
  if (!existing) return null;
  const updated: EventDoc = {
    name: fields.name ?? existing.name,
    startDate: fields.startDate ?? existing.startDate,
    status: fields.status ?? existing.status,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
  };
  await client.setDoc(COLLECTION, eventId, updated);
  return { id: eventId, ...updated };
}
