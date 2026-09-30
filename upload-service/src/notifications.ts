// E-mail notification content and recipient resolution. Sending itself lives in mailer.ts; this
// file decides WHO gets WHAT. Every entry point here is best-effort: it runs after the business
// write it describes has already committed, logs a failure, and never throws back into the
// request handler.
import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';
import type { MailMessage, Mailer } from './mailer.ts';
import { listAllGrantedRoles } from './roles.ts';
import { listAllMembers } from './members.ts';

// Roles an admin can pick as recipients of the "new member application" e-mail. 'member' is
// deliberately absent - every active member holds it implicitly, which would mail the whole club.
export const NOTIFIABLE_ROLES = ['admin', 'hovding', 'accountant'] as const;
export type NotifiableRole = (typeof NOTIFIABLE_ROLES)[number];

export interface NotificationSettings {
  registrationRecipientRoles: NotifiableRole[];
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  registrationRecipientRoles: ['admin', 'hovding'],
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
  const roles = parseNotifiableRoles(doc?.registrationRecipientRoles);
  return roles ? { registrationRecipientRoles: roles } : { ...DEFAULT_NOTIFICATION_SETTINGS };
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

/** Sends each message independently; one bad address or failed send never blocks the rest. */
export async function sendNotifications(mailer: Mailer, messages: readonly MailMessage[]): Promise<void> {
  await Promise.all(messages.map(message => mailer.send(message).catch(err => {
    console.error('Wysłanie powiadomienia e-mail nie powiodło się:', err);
    return 'failed' as const;
  })));
}

/** Trims an optional admin comment; empty means "no comment" (the generic text is used). */
export function normalizeRejectionReason(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_REJECTION_REASON_LENGTH) return undefined;
  return trimmed || null;
}
