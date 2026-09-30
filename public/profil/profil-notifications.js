// /profil/ "Powiadomienia" panel: e-mail opt-out and push on this device. Loaded before profil.js
// and started from its onSignedIn (initNotificationSettings) - it reuses that page's apiFetch,
// showReauth and hideReauth globals. Everything here saves immediately.

function pushSupported() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// VAPID public key (base64url) -> the Uint8Array pushManager.subscribe wants.
function vapidKeyToBytes(base64url) {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// The same worker the public pages register (pwa-register.js); registering it again is a no-op.
async function pushRegistration() {
  await navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

function setPushHint(text) {
  const hint = document.getElementById('notify-push-hint');
  hint.textContent = text;
  hint.hidden = !text;
}

function showNotificationsError(message) {
  const errorEl = document.getElementById('notifications-error');
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

async function saveEmailPreference(control) {
  const emailEnabled = control.checked;
  showNotificationsError('');
  control.disabled = true;
  try {
    await window.MutationFeedback.confirmed({
      control,
      anchor: control.closest('label'),
      execute: () => apiFetch(
        '/profile/notifications',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emailEnabled }) },
        showReauth,
        hideReauth,
      ),
      apply: saved => { control.checked = saved.emailEnabled; },
    });
  } catch (err) {
    control.checked = !emailEnabled;
    showNotificationsError(`Błąd: ${err.message}`);
  } finally {
    control.disabled = false;
  }
}

async function enablePush(control, publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    control.checked = false;
    setPushHint('Przeglądarka nie zezwoliła na powiadomienia. Zmień to w ustawieniach strony w przeglądarce.');
    return;
  }
  const registration = await pushRegistration();
  const options = { userVisibleOnly: true, applicationServerKey: vapidKeyToBytes(publicKey) };
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    // An existing subscription made with a different key (keys rotated) can't be reused.
    const existingKey = subscription.options && subscription.options.applicationServerKey;
    const sameKey = existingKey && new Uint8Array(existingKey).join() === options.applicationServerKey.join();
    if (!sameKey) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  if (!subscription) subscription = await registration.pushManager.subscribe(options);
  const payload = JSON.stringify({ subscription: subscription.toJSON() });
  await window.MutationFeedback.confirmed({
    control,
    anchor: control.closest('label'),
    execute: () => apiFetch(
      '/profile/notifications/push',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload },
      showReauth,
      hideReauth,
    ),
    apply: saved => { control.checked = saved.endpoints.includes(subscription.endpoint); },
  });
  setPushHint('');
}

async function disablePush(control) {
  const registration = await pushRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    control.checked = false;
    return;
  }
  const payload = JSON.stringify({ endpoint: subscription.endpoint });
  await window.MutationFeedback.confirmed({
    control,
    anchor: control.closest('label'),
    execute: () => apiFetch(
      '/profile/notifications/push',
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: payload },
      showReauth,
      hideReauth,
    ),
    apply: saved => { control.checked = saved.endpoints.includes(subscription.endpoint); },
  });
  // Only after the server forgot it - a failed DELETE leaves this device subscribed and checked.
  await subscription.unsubscribe().catch(() => {});
}

async function renderPushRow(push) {
  const row = document.getElementById('notify-push-row');
  const control = document.getElementById('notify-push');
  if (!push.publicKey || !push.eligible) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  if (!pushSupported()) {
    control.disabled = true;
    setPushHint('Ta przeglądarka nie obsługuje powiadomień push. Na iPhonie dodaj stronę do ekranu początkowego (Udostępnij → Do ekranu początkowego) i otwórz ją stamtąd.');
    return;
  }
  if (Notification.permission === 'denied') {
    control.disabled = true;
    setPushHint('Powiadomienia są zablokowane dla tej strony w ustawieniach przeglądarki.');
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  control.checked = Boolean(subscription && push.endpoints.includes(subscription.endpoint));
  control.addEventListener('change', async () => {
    const enable = control.checked;
    showNotificationsError('');
    control.disabled = true;
    try {
      if (enable) await enablePush(control, push.publicKey);
      else await disablePush(control);
    } catch (err) {
      control.checked = !enable;
      showNotificationsError(`Błąd: ${err.message}`);
    } finally {
      control.disabled = false;
    }
  });
}

async function initNotificationSettings() {
  const panel = document.getElementById('notifications-panel');
  try {
    const settings = await apiFetch('/profile/notifications', { method: 'GET' }, showReauth, hideReauth);
    const emailControl = document.getElementById('notify-email');
    emailControl.checked = settings.emailEnabled;
    emailControl.addEventListener('change', () => saveEmailPreference(emailControl));
    panel.hidden = false;
    await renderPushRow(settings.push);
  } catch (err) {
    panel.hidden = false;
    showNotificationsError(`Nie udało się wczytać ustawień powiadomień: ${err.message}`);
  }
}
