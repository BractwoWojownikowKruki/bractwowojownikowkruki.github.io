import type { FirestoreDoc, FirestoreLikeClient } from './firestore.ts';

/**
 * Whether one piece of camp equipment is going on one specific trip.
 *
 * Documents are created only after the first toggle for an event/equipment pair; no document
 * means the equipment is not going. This keeps the per-event state sparse, matching signups.
 */
export interface EventEquipmentDoc {
  eventId: string;
  equipmentId: string;
  going: boolean;
  lastChangedBy: string;
  lastChangedAt: string;
}

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

const COLLECTION = 'eventEquipment';

export function eventEquipmentId(eventId: string, equipmentId: string): string {
  return `${eventId}_${equipmentId}`;
}

export async function listAllEventEquipment(client: FirestoreLikeClient): Promise<FirestoreDoc<EventEquipmentDoc>[]> {
  return client.listDocs<EventEquipmentDoc>(COLLECTION);
}

export async function listEventEquipmentForEvent(client: FirestoreLikeClient, eventId: string): Promise<EventEquipmentDoc[]> {
  const all = await listAllEventEquipment(client);
  return all.filter(doc => doc.data.eventId === eventId).map(doc => doc.data);
}

export async function getEventEquipment(
  client: Pick<FirestoreLikeClient, 'getDoc'>,
  eventId: string,
  equipmentId: string,
): Promise<EventEquipmentDoc | null> {
  return client.getDoc<EventEquipmentDoc>(COLLECTION, eventEquipmentId(eventId, equipmentId));
}

export async function saveEventEquipment(
  client: FirestoreWriteContext,
  eventId: string,
  equipmentId: string,
  going: boolean,
  changedBy: string,
): Promise<EventEquipmentDoc> {
  const doc: EventEquipmentDoc = {
    eventId,
    equipmentId,
    going,
    lastChangedBy: changedBy.toLowerCase(),
    lastChangedAt: new Date().toISOString(),
  };
  await client.setDoc(COLLECTION, eventEquipmentId(eventId, equipmentId), doc);
  return doc;
}
