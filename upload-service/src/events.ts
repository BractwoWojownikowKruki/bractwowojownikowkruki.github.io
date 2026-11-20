/**
 * Trip ("wyjazd") documents of Lista Wyjazdowa: CRUD helpers used by the /lista-wyjazdowa/events routes
 * in server.ts, which wrap them in audited transactions. Besides plain create/update this module
 * enforces KRKG-132's rule that two active events cannot share startDate + slugified name (the
 * friendly-URL slug), using per-slug lock documents in `eventSlugLocks`.
 */
import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;
type FirestoreSlugContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc' | 'deleteDoc'>;

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
  id: string = randomUUID(),
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

// KRKG-132: two active events may not share the same startDate + slugified name. That pair is also
// the friendly URL (`?do=<slug>`, see public/shared/lw-friendly-url.js, whose slug logic this
// mirrors and a parity test keeps identical), so a duplicate would make one of the two unreachable.
// A cancelled event does not hold its slug, so a replacement can be created and the cancelled one
// can only be restored once the slug is free again.
export const EVENT_SLUG_CONFLICT_MESSAGE = 'Wyjazd o tej nazwie i dacie już istnieje.';

/** Thrown when an event would duplicate the date + name of another active event. */
export class EventSlugConflictError extends Error {
  constructor() {
    super(EVENT_SLUG_CONFLICT_MESSAGE);
    this.name = 'EventSlugConflictError';
  }
}

const SLUG_LOCK_COLLECTION = 'eventSlugLocks';
const SLUG_DIACRITICS: Record<string, string> = { 'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z' };

export function slugifyEventName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => SLUG_DIACRITICS[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function eventSlug(event: { startDate: string; name: string }): string {
  return `${event.startDate}-${slugifyEventName(event.name)}`;
}

/** The active event (other than `excludeId`) already using `slug`, from a full event listing. */
export function findActiveSlugConflict(events: EventWithId[], slug: string, excludeId?: string): EventWithId | undefined {
  return events.find((e) => e.id !== excludeId && e.status === 'active' && eventSlug(e) === slug);
}

interface SlugLockDoc { eventId: string }

/**
 * Takes the per-slug lock document for `eventId`. Collections cannot be scanned inside a Firestore
 * transaction, so this lock is what makes two concurrent creates of the same date + name race
 * safely: both read the same lock and the transaction commit serializes them. A lock whose owner
 * no longer holds that slug as an active event is stale and is simply taken over, so a missed
 * release can never block anyone permanently.
 */
async function claimSlug(tx: FirestoreSlugContext, slug: string, eventId: string): Promise<void> {
  const lock = await tx.getDoc<SlugLockDoc>(SLUG_LOCK_COLLECTION, slug);
  if (lock && lock.eventId !== eventId) {
    const owner = await tx.getDoc<EventDoc>(COLLECTION, lock.eventId);
    if (owner && owner.status === 'active' && eventSlug(owner) === slug) throw new EventSlugConflictError();
  }
  await tx.setDoc(SLUG_LOCK_COLLECTION, slug, { eventId } satisfies SlugLockDoc);
}

/** Releases `slug` only if `eventId` owns it; used when an event is renamed, redated, cancelled or deleted. */
export async function releaseSlug(tx: FirestoreSlugContext, slug: string, eventId: string): Promise<void> {
  const lock = await tx.getDoc<SlugLockDoc>(SLUG_LOCK_COLLECTION, slug);
  if (lock?.eventId === eventId) await tx.deleteDoc(SLUG_LOCK_COLLECTION, slug);
}

/** createEvent plus the slug uniqueness guarantee; run inside a transaction. */
export async function createEventUniqueSlug(
  tx: FirestoreSlugContext,
  fields: Parameters<typeof createEvent>[1],
  createdBy: string,
  id: string = randomUUID(),
): Promise<EventWithId> {
  await claimSlug(tx, eventSlug(fields), id);
  return createEvent(tx, fields, createdBy, id);
}

/**
 * updateEvent plus the slug uniqueness guarantee; run inside a transaction. Only a change of
 * name/date, or restoring a cancelled event, needs the slug claimed, so editing unrelated fields
 * of an event is never blocked. Cancelling or moving away releases the old slug.
 */
export async function updateEventUniqueSlug(
  tx: FirestoreSlugContext,
  eventId: string,
  fields: EventWritableFields,
): Promise<EventWithId | null> {
  const existing = await tx.getDoc<EventDoc>(COLLECTION, eventId);
  if (!existing) return null;
  const next = { ...existing, ...fields };
  const oldSlug = eventSlug(existing);
  const newSlug = eventSlug(next);
  if (next.status === 'active') {
    if (newSlug !== oldSlug || existing.status !== 'active') await claimSlug(tx, newSlug, eventId);
    if (newSlug !== oldSlug) await releaseSlug(tx, oldSlug, eventId);
  } else {
    await releaseSlug(tx, oldSlug, eventId);
  }
  return updateEvent(tx, eventId, fields);
}
