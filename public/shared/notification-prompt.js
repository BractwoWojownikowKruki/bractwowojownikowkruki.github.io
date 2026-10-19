// Site-wide pop-up (KRKG-114) inviting a signed-in member who has NO notifications switched on -
// e-mail opted out AND no push device subscribed - to turn them on at /profil/. Loaded from the
// footer partial on every page; it wires itself up with initGoogleSignIn, so it does nothing for a
// signed-out visitor. The notification state comes from GET /profile/notifications every time the
// pop-up is due (nothing is cached), so the server decides what "enabled" means.
//
// Frequency: at most one showing every two weeks per browser. The time of the last showing lives in
// this browser's localStorage only (per-device reminder, never the server). Showing it records the
// time, and so do the dismiss and action paths. Storage can be blocked or throw (private mode), so
// every access is wrapped in try/catch: a failed read means "never shown" and a failed write is
// dropped - the worst case is the pop-up returning on a later page load.
//
// This file must have no top-level side effects beyond the DOMContentLoaded listener, because
// scripts/notification-prompt.test.ts loads it into a vm context with stubs.

const NOTIFICATION_PROMPT_KEY = 'kruki_notification_prompt_last_shown';
const NOTIFICATION_PROMPT_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
const NOTIFICATION_SETTINGS_PATH = '/profil/';

function readNotificationPromptLastShown() {
  try {
    const raw = localStorage.getItem(NOTIFICATION_PROMPT_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // localStorage can throw in some privacy modes - treat that as "never shown".
    return null;
  }
}

function writeNotificationPromptLastShown(nowMs) {
  try {
    localStorage.setItem(NOTIFICATION_PROMPT_KEY, String(nowMs));
  } catch {
    // localStorage can throw in some privacy modes - the pop-up may come back on a later page load.
  }
}

// Due when it was never shown here, or the last showing is at least two weeks old. A timestamp in
// the future (clock moved back) counts as never shown, so a wrong clock cannot hide the pop-up for
// an unbounded time.
function isNotificationPromptDue(lastShownMs, nowMs) {
  if (lastShownMs === null || lastShownMs > nowMs) return true;
  return nowMs - lastShownMs >= NOTIFICATION_PROMPT_INTERVAL_MS;
}

// GET /profile/notifications shape: emailEnabled (the server defaults it to true) and push.endpoints
// (the member's registered push devices). Anything that is not exactly that shape fails closed - no
// pop-up - so an unexpected response can never nag a member who may already be subscribed.
function hasNoNotificationsEnabled(settings) {
  if (!settings || settings.emailEnabled !== false) return false;
  return Boolean(settings.push) && Array.isArray(settings.push.endpoints) && settings.push.endpoints.length === 0;
}

function showNotificationPrompt() {
  writeNotificationPromptLastShown(Date.now());

  const root = document.createElement('div');
  root.className = 'reauth-modal notification-prompt';

  const dialog = document.createElement('div');
  dialog.className = 'reauth-modal-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'notification-prompt-title');

  const title = document.createElement('h2');
  title.id = 'notification-prompt-title';
  title.className = 'reauth-modal-title';
  title.textContent = 'Włącz powiadomienia';

  const text = document.createElement('p');
  text.className = 'notification-prompt-text';
  text.textContent = 'Nie masz włączonych powiadomień ani e-mailem, ani w przeglądarce. Włącz je w ustawieniach profilu, żeby nie przegapić ważnych informacji dla członków Bractwa.';

  const actions = document.createElement('div');
  actions.className = 'notification-prompt-actions';

  const settingsLink = document.createElement('a');
  settingsLink.className = 'add-album-submit notification-prompt-action';
  settingsLink.href = NOTIFICATION_SETTINGS_PATH;
  settingsLink.textContent = 'Przejdź do ustawień powiadomień';
  // Navigates away anyway; the timestamp is already set by showNotificationPrompt, this refreshes it.
  settingsLink.addEventListener('click', () => writeNotificationPromptLastShown(Date.now()));

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn-cancel notification-prompt-dismiss';
  dismiss.textContent = 'Nie teraz';

  const close = () => {
    writeNotificationPromptLastShown(Date.now());
    document.removeEventListener('keydown', onKeydown);
    root.remove();
  };
  const onKeydown = event => {
    if (event.key === 'Escape') close();
  };
  dismiss.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  actions.append(settingsLink, dismiss);
  dialog.append(title, text, actions);
  root.append(dialog);
  document.body.append(root);
  settingsLink.focus();
}

// Cheap local check first, so the member's settings are only fetched when a pop-up could be shown.
// Skipped on /profil/ itself, where the same switches are already on screen.
async function checkNotificationPrompt() {
  if (location.pathname.startsWith(NOTIFICATION_SETTINGS_PATH)) return;
  if (!isNotificationPromptDue(readNotificationPromptLastShown(), Date.now())) return;

  let settings;
  try {
    // No reauth callbacks: a 401 here only means no usable session, and the pop-up stays quiet.
    settings = await apiFetch('/profile/notifications', { method: 'GET' });
  } catch {
    // A failed check says nothing about the member's settings - the next page load tries again.
    return;
  }
  if (hasNoNotificationsEnabled(settings)) showNotificationPrompt();
}

// The footer script runs before auth.js and nav.js (both later in the body), so wire up only once the
// parser has run every classic script. initGoogleSignIn is the same page-level listener index-redirect.js
// uses; it runs onSignedIn only for a verified member session.
document.addEventListener('DOMContentLoaded', () => {
  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/wojownicy-upload/whoami',
    onSignedIn: () => { void checkNotificationPrompt(); },
  });
});
