import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

export interface EventDoc {
  name: string;
  startDate: string; // YYYY-MM-DD
  status: 'active' | 'cancelled';
  createdBy: string;
  createdAt: string;
  description: string | null; // free-text trip info (location, links, what to bring) - KRKG-0102
  skladkaFee: string | null; // free-text fee description, accountant/admin-set — see server.ts's role check
  dueDate: string | null; // YYYY-MM-DD, accountant/admin-set payment deadline for skladkaFee (KRKG-0080)
  noCampEquipment?: boolean; // trip needs no camp equipment, so the roster page hides the equipment table (absent = false)
  mapUrl?: string | null; // Google Maps pin with directions; the detail page's "Wskazówki dojazdu" button (absent = none)
  discordUrl?: string | null; // Discord thread for the trip; the detail page's "Temat na Discordzie" button (absent = none)
}

export interface EventWithId extends EventDoc {
  id: string;
}

export interface EventWritableFields {
  name?: string;
  startDate?: string;
  status?: 'active' | 'cancelled';
  description?: string | null;
  skladkaFee?: string | null;
  dueDate?: string | null;
  noCampEquipment?: boolean;
  mapUrl?: string | null;
  discordUrl?: string | null;
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
  client: FirestoreWriteContext,
  fields: { name: string; startDate: string; description?: string | null; noCampEquipment?: boolean; mapUrl?: string | null; discordUrl?: string | null },
  createdBy: string,
  id = randomUUID(),
): Promise<EventWithId> {
  const doc: EventDoc = {
    name: fields.name,
    startDate: fields.startDate,
    status: 'active',
    createdBy,
    createdAt: new Date().toISOString(),
    description: fields.description ?? null,
    skladkaFee: null,
    dueDate: null,
    noCampEquipment: fields.noCampEquipment ?? false,
    mapUrl: fields.mapUrl ?? null,
    discordUrl: fields.discordUrl ?? null,
  };
  await client.setDoc(COLLECTION, id, doc);
  return { id, ...doc };
}

export async function updateEvent(
  client: FirestoreWriteContext,
  eventId: string,
  fields: EventWritableFields,
): Promise<EventWithId | null> {
  const existing = await client.getDoc<EventDoc>(COLLECTION, eventId);
  if (!existing) return null;
  await client.setDoc(COLLECTION, eventId, fields);
  return { id: eventId, ...existing, ...fields };
}
