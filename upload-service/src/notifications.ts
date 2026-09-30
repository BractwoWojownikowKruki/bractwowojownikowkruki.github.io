// E-mail and push notification content and recipient resolution. Sending itself lives in
// mailer.ts/pusher.ts; this file decides WHO gets WHAT. Every entry point here is best-effort: it runs after the business
// write it describes has already committed, logs a failure, and never throws back into the
// request handler.
import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';
import type { MailMessage, Mailer } from './mailer.ts';
import type { PushMessage, PushSubscriptionRecord, Pusher } from './pusher.ts';
import { listAllGrantedRoles } from './roles.ts';
import { listAllMembers } from './members.ts';

// Roles an admin can pick as recipients of the "new member application" e-mail. 'member' is
// deliberately absent - every active member holds it implicitly, which would mail the whole club.
export const NOTIFIABLE_ROLES = ['admin', 'hovding', 'accountant'] as const;
export type NotifiableRole = (typeof NOTIFIABLE_ROLES)[number];

export interface NotificationSettings {
  // E-mail recipients of the admin-facing notifications (new application, new photos).
  registrationRecipientRoles: NotifiableRole[];
  // Push recipients of the same notifications. Separate from e-mail so an admin can, say, e-mail
  // hovdings but only push to administrators. A holder still only gets a push once they enable
  // it on a device (/profil/).
  pushRecipientRoles: NotifiableRole[];
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  registrationRecipientRoles: ['admin', 'hovding'],
  pushRecipientRoles: ['admin', 'hovding'],
};

const SETTINGS_COLLECTION = 'notificationSettings';
const SETTINGS_DOC_ID = 'default';

// Free-text an admin types into a rejection. Bounded well under maxJsonBodyBytes so one field
// can't be what fills the request.
export const MAX_REJECTION_REASON_LENGTH = 1000;

export function parseNotifiableRoles(value: unknown): NotifiableRole[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some(role => !(NOTIFIABLE_ROLES as readonly unknown[]).includes(role))) return null;
  // Stored in canonical order and de-duplicated, so the audit diff only changes on a real change.
  return NOTIFIABLE_ROLES.filter(role => value.includes(role));
}

// A missing or malformed doc falls back to the default rather than throwing - this is read on
// every membership application, which must never fail because of a notification setting.
export async function getNotificationSettings(client: Pick<FirestoreLikeClient, 'getDoc'>): Promise<NotificationSettings> {
  const doc = await client.getDoc<Partial<NotificationSettings>>(SETTINGS_COLLECTION, SETTINGS_DOC_ID);
  return {
    registrationRecipientRoles: parseNotifiableRoles(doc?.registrationRecipientRoles) ?? [...DEFAULT_NOTIFICATION_SETTINGS.registrationRecipientRoles],
    // A doc saved before push existed has no pushRecipientRoles yet - it gets the default.
    pushRecipientRoles: parseNotifiableRoles(doc?.pushRecipientRoles) ?? [...DEFAULT_NOTIFICATION_SETTINGS.pushRecipientRoles],
  };
}

export async function setNotificationSettingsInTransaction(tx: FirestoreTransaction, settings: NotificationSettings): Promise<NotificationSettings> {
  await tx.setDoc(SETTINGS_COLLECTION, SETTINGS_DOC_ID, settings);
  return settings;
}

export interface RecipientSources {
  firestore: FirestoreLikeClient;
  // The /admin allowlist sheet - what actually makes someone an administrator of this site (see
  // config.ts's adminAllowlistSheetUrl). Firestore 'admin' grants are added on top of it.
  listAdminAllowlistEmails: () => Promise<string[]>;
}

/**
 * Everyone who should hear about a new application: holders of any configured role. A Firestore
 * role only counts while its holder is an active member - the same rule getEffectiveRoles
 * applies to authorization - so a suspended hovding stops receiving these too.
 */
export async function resolveRegistrationRecipients(sources: RecipientSources, roles: readonly NotifiableRole[]): Promise<string[]> {
  if (roles.length === 0) return [];
  const [grants, members, allowlist] = await Promise.all([
    listAllGrantedRoles(sources.firestore),
    listAllMembers(sources.firestore),
    roles.includes('admin') ? sources.listAdminAllowlistEmails().catch(err => {
      console.error('Nie udało się pobrać listy administratorów dla powiadomień:', err);
      return [] as string[];
    }) : Promise.resolve([] as string[]),
  ]);
  const activeEmails = new Set(members.filter(m => m.status === 'active').map(m => m.email.toLowerCase()));
  const recipients = new Set(allowlist.map(email => email.trim().toLowerCase()).filter(Boolean));
  for (const grant of grants) {
    const email = grant.email.toLowerCase();
    if (activeEmails.has(email) && grant.roles.some(role => (roles as readonly string[]).includes(role))) {
      recipients.add(email);
    }
  }
  return [...recipients].sort();
}

// Per-person choices, keyed by lowercased e-mail. A missing doc means the defaults: e-mail on, no
// push devices.
const PREFERENCES_COLLECTION = 'notificationPreferences';
// Each browser/phone that enabled push is one subscription. Bounded so a person who keeps
// clearing site data can't grow the doc without limit; the oldest is dropped first.
export const MAX_PUSH_SUBSCRIPTIONS_PER_PERSON = 10;

export interface StoredPushSubscription extends PushSubscriptionRecord {
  createdAt: string;
}

export interface NotificationPreferences {
  // false = the person opted out of every notification e-mail (admin-facing and personal ones).
  emailEnabled: boolean;
  pushSubscriptions: StoredPushSubscription[];
}

function normalizePreferences(doc: Partial<NotificationPreferences> | null): NotificationPreferences {
  return {
    emailEnabled: doc?.emailEnabled !== false,
    pushSubscriptions: Array.isArray(doc?.pushSubscriptions) ? doc.pushSubscriptions : [],
  };
}

export async function getNotificationPreferences(client: Pick<FirestoreLikeClient, 'getDoc'>, email: string): Promise<NotificationPreferences> {
  return normalizePreferences(await client.getDoc<Partial<NotificationPreferences>>(PREFERENCES_COLLECTION, email.toLowerCase()));
}

export async function setEmailEnabledInTransaction(tx: FirestoreTransaction, email: string, emailEnabled: boolean): Promise<NotificationPreferences> {
  const current = normalizePreferences(await tx.getDoc<Partial<NotificationPreferences>>(PREFERENCES_COLLECTION, email.toLowerCase()));
  const next = { ...current, emailEnabled };
  await tx.setDoc(PREFERENCES_COLLECTION, email.toLowerCase(), next);
  return next;
}

/** Adds (or refreshes, same endpoint) one device's subscription. */
export async function addPushSubscriptionInTransaction(
  tx: FirestoreTransaction,
  email: string,
  subscription: PushSubscriptionRecord,
  now: Date,
): Promise<NotificationPreferences> {
  const current = normalizePreferences(await tx.getDoc<Partial<NotificationPreferences>>(PREFERENCES_COLLECTION, email.toLowerCase()));
  const others = current.pushSubscriptions.filter(existing => existing.endpoint !== subscription.endpoint);
  const pushSubscriptions = [...others, { ...subscription, createdAt: now.toISOString() }].slice(-MAX_PUSH_SUBSCRIPTIONS_PER_PERSON);
  const next = { ...current, pushSubscriptions };
  await tx.setDoc(PREFERENCES_COLLECTION, email.toLowerCase(), next);
  return next;
}

export async function removePushSubscriptionInTransaction(tx: FirestoreTransaction, email: string, endpoint: string): Promise<NotificationPreferences> {
  const current = normalizePreferences(await tx.getDoc<Partial<NotificationPreferences>>(PREFERENCES_COLLECTION, email.toLowerCase()));
  const next = { ...current, pushSubscriptions: current.pushSubscriptions.filter(existing => existing.endpoint !== endpoint) };
  await tx.setDoc(PREFERENCES_COLLECTION, email.toLowerCase(), next);
  return next;
}

const SIGNATURE = '\n\n--\nBractwo Wojowników Kruki\nWiadomość wysłana automatycznie - prosimy na nią nie odpowiadać.';

export function registrationSubmittedMessage(
  to: string,
  applicant: { email: string; firstName: string; lastName: string; nickname?: string | null },
  siteUrl: string,
): MailMessage {
  const fullName = `${applicant.firstName} ${applicant.lastName}`.trim();
  const nickname = applicant.nickname ? ` (${applicant.nickname})` : '';
  return {
    to,
    subject: `Nowe zgłoszenie członkowskie: ${fullName}`,
    text:
      `Nowa osoba złożyła zgłoszenie członkowskie:\n\n` +
      `${fullName}${nickname}\n${applicant.email}\n\n` +
      `Zgłoszenie czeka na akceptację: ${siteUrl}/admin/zgloszenia/` +
      SIGNATURE,
  };
}

export function photosSubmittedMessage(
  to: string,
  uploader: { email: string; firstName: string; lastName: string; nickname?: string | null },
  photoCount: number,
  siteUrl: string,
): MailMessage {
  const fullName = `${uploader.firstName} ${uploader.lastName}`.trim() || uploader.email;
  const nickname = uploader.nickname ? ` (${uploader.nickname})` : '';
  return {
    to,
    subject: `Nowe zdjęcia do zatwierdzenia: ${fullName}`,
    text:
      `${fullName}${nickname} (${uploader.email}) przesłał(a) nowe zdjęcia: ${photoCount}.\n\n` +
      `Zdjęcia czekają na zatwierdzenie w dziale Upload: ${siteUrl}/admin/publiczne-wizytowki/` +
      SIGNATURE,
  };
}

export function membershipDecisionMessage(to: string, decision: 'approved' | 'rejected', reason: string | null, siteUrl: string): MailMessage {
  if (decision === 'approved') {
    return {
      to,
      subject: 'Twoje zgłoszenie członkowskie zostało zaakceptowane',
      text:
        `Witaj w Bractwie Wojowników Kruki!\n\n` +
        `Twoje zgłoszenie członkowskie zostało zaakceptowane. Możesz już korzystać ze Strefy Członków: ${siteUrl}/app/` +
        SIGNATURE,
    };
  }
  return {
    to,
    subject: 'Twoje zgłoszenie członkowskie zostało odrzucone',
    text:
      `Twoje zgłoszenie członkowskie zostało odrzucone.\n\n` +
      (reason ? `Komentarz: ${reason}` : 'Jeśli nie wiesz dlaczego, skontaktuj się ze swoim hovdingiem.') +
      SIGNATURE,
  };
}

export const GENERIC_PHOTO_REJECTION_MESSAGE =
  'Twoje zdjęcia zostały odrzucone z powodu problemów. Jeśli nie wiesz, o co chodzi, skontaktuj się ze swoim hovdingiem.';

export function photoDecisionMessage(to: string, decision: 'approved' | 'rejected', count: number, reason: string | null, siteUrl: string): MailMessage {
  if (decision === 'approved') {
    return {
      to,
      subject: count === 1 ? 'Twoje zdjęcie zostało zaakceptowane' : 'Twoje zdjęcia zostały zaakceptowane',
      text:
        `Zaakceptowane zdjęcia: ${count}. Są już widoczne na Twojej publicznej wizytówce.\n\n` +
        `Zobacz swój profil: ${siteUrl}/profil/` +
        SIGNATURE,
    };
  }
  return {
    to,
    subject: count === 1 ? 'Twoje zdjęcie zostało odrzucone' : 'Twoje zdjęcia zostały odrzucone',
    text:
      `Odrzucone zdjęcia: ${count}.\n\n` +
      (reason ? `Komentarz: ${reason}` : GENERIC_PHOTO_REJECTION_MESSAGE) +
      `\n\nOdrzucone zdjęcia są widoczne na Twoim profilu, gdzie możesz je usunąć: ${siteUrl}/profil/` +
      SIGNATURE,
  };
}

export function registrationSubmittedPush(applicant: { firstName: string; lastName: string; nickname?: string | null }): PushMessage {
  const fullName = `${applicant.firstName} ${applicant.lastName}`.trim();
  const nickname = applicant.nickname ? ` (${applicant.nickname})` : '';
  return { title: 'Nowe zgłoszenie członkowskie', body: `${fullName}${nickname}`, url: '/admin/zgloszenia/' };
}

export function photosSubmittedPush(
  uploader: { email: string; firstName: string; lastName: string; nickname?: string | null },
  photoCount: number,
): PushMessage {
  const fullName = `${uploader.firstName} ${uploader.lastName}`.trim() || uploader.email;
  const nickname = uploader.nickname ? ` (${uploader.nickname})` : '';
  return { title: 'Nowe zdjęcia do zatwierdzenia', body: `${fullName}${nickname}: ${photoCount}`, url: '/admin/publiczne-wizytowki/' };
}

/**
 * Sends each message independently; one bad address or failed send never blocks the rest.
 * Recipients who opted out of e-mail (/profil/) are skipped; a failed preference read errs
 * towards sending, the same "never lose a notification to a settings problem" rule as
 * getNotificationSettings.
 */
export async function sendNotifications(
  mailer: Mailer,
  preferences: Pick<FirestoreLikeClient, 'getDoc'>,
  messages: readonly MailMessage[],
): Promise<void> {
  await Promise.all(messages.map(async message => {
    const optedOut = await getNotificationPreferences(preferences, message.to).then(prefs => !prefs.emailEnabled, err => {
      console.error('Nie udało się odczytać preferencji powiadomień:', err);
      return false;
    });
    if (optedOut) return 'skipped' as const;
    return mailer.send(message).catch(err => {
      console.error('Wysłanie powiadomienia e-mail nie powiodło się:', err);
      return 'failed' as const;
    });
  }));
}

/**
 * Pushes one message to every device of every recipient. A subscription the push service
 * reports as gone is only logged, not removed here: removing it is a Firestore write with no
 * acting person to audit it under. It drops off when the person re-enables push on that browser
 * (new endpoint, oldest evicted past MAX_PUSH_SUBSCRIPTIONS_PER_PERSON) or disables it.
 */
export async function sendPushNotifications(
  pusher: Pusher,
  preferences: Pick<FirestoreLikeClient, 'getDoc'>,
  recipients: readonly string[],
  message: PushMessage,
): Promise<void> {
  if (!pusher.publicKey) return;
  await Promise.all(recipients.map(async email => {
    try {
      const prefs = await getNotificationPreferences(preferences, email);
      const results = await Promise.all(prefs.pushSubscriptions.map(subscription => pusher.send(subscription, message)));
      const gone = results.filter(status => status === 'gone').length;
      if (gone > 0) console.warn(`Wygasłe subskrypcje push (${gone}) dla ${email}.`);
    } catch (err) {
      console.error('Wysłanie powiadomienia push nie powiodło się:', err);
    }
  }));
}

/** Trims an optional admin comment; empty means "no comment" (the generic text is used). */
export function normalizeRejectionReason(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_REJECTION_REASON_LENGTH) return undefined;
  return trimmed || null;
}
