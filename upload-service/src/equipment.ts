import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';

export interface EquipmentDoc {
  id: string;
  categoryId: string;
  sectionId: string;
  belongsToPersonId: string | null;
  description: string;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface EquipmentWritableFields {
  categoryId: string;
  sectionId: string;
  belongsToPersonId: string | null;
  description: string;
}

/** A submitted equipment record missing a required field (KRKG-0096). */
export class InvalidEquipmentError extends Error {}

const COLLECTION = 'equipment';
const MAX_LISTED_EQUIPMENT = 500;
const MAX_DESCRIPTION_LENGTH = 500;

/** Runtime validation of the fields the model requires - mirrors persons.ts's own validation
 * function for the same reason: TypeScript's required properties don't stop a request body from
 * carrying empty strings. categoryId/sectionId are checked here for non-emptiness only - referential
 * validation against the equipmentCategories/sections lookup lists (and belongsToPersonId's
 * resolution to a live member or person) lives in server.ts's validateEquipmentReferences, which
 * uses the same requireKnownLookupId convention as parseMemberWritableFields/
 * handleListaWyjazdowaPutProfile: a retired category/section stays valid on an item that already
 * has it, since this module has no access to the lookup lists on its own. */
export function validateEquipmentFields(fields: EquipmentWritableFields): void {
  if (!fields.categoryId?.trim()) throw new InvalidEquipmentError('Kategoria jest wymagana.');
  if (!fields.sectionId?.trim()) throw new InvalidEquipmentError('Sekcja jest wymagana.');
  if (fields.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidEquipmentError(`Opis może mieć najwyżej ${MAX_DESCRIPTION_LENGTH} znaków.`);
  }
}

export function buildEquipmentDoc(fields: EquipmentWritableFields, createdByEmail: string): EquipmentDoc {
  validateEquipmentFields(fields);
  return {
    id: randomUUID(),
    categoryId: fields.categoryId,
    sectionId: fields.sectionId,
    belongsToPersonId: fields.belongsToPersonId,
    description: fields.description,
    createdAt: new Date().toISOString(),
    createdBy: createdByEmail.toLowerCase(),
  };
}

export async function saveEquipmentInTransaction(tx: FirestoreTransaction, doc: EquipmentDoc): Promise<void> {
  await tx.createDoc(COLLECTION, doc.id, doc);
}

export async function updateEquipmentInTransaction(
  tx: FirestoreTransaction,
  existing: EquipmentDoc,
  fields: EquipmentWritableFields,
  updatedByEmail: string,
): Promise<EquipmentDoc> {
  validateEquipmentFields(fields);
  const updated: EquipmentDoc = {
    ...existing,
    categoryId: fields.categoryId,
    sectionId: fields.sectionId,
    belongsToPersonId: fields.belongsToPersonId,
    description: fields.description,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedByEmail.toLowerCase(),
  };
  await tx.setDoc(COLLECTION, updated.id, updated);
  return updated;
}

export async function deleteEquipmentInTransaction(tx: FirestoreTransaction, id: string): Promise<void> {
  await tx.deleteDoc(COLLECTION, id);
}

export async function getEquipmentInTransaction(tx: FirestoreTransaction, id: string): Promise<EquipmentDoc | null> {
  return tx.getDoc<EquipmentDoc>(COLLECTION, id);
}

export async function listEquipment(client: FirestoreLikeClient, limit: number = MAX_LISTED_EQUIPMENT): Promise<EquipmentDoc[]> {
  const all = await client.listDocs<EquipmentDoc>(COLLECTION);
  return all.map((d) => d.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
