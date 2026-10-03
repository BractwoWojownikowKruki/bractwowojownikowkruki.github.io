/**
 * Helpers shared by every admin panel page (Ogólne, Zgłoszenia, Zarządzanie ludźmi, Publiczne
 * wizytówki - KRKG-0049 split the panel from one page into these four). Load this before the
 * page's own script. Each page still wires its own initGoogleSignIn/admin-panel boilerplate.
 * showReauth/hideReauth are only apiFetch's opt-in for the shared reauth modal (see auth.js).
 */
function showReauth() {}
function hideReauth() {}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function sheetSyncStatusMessage(status) {
  if (status === 'failed') return 'Zapisano, ale nie udało się zaktualizować kopii w arkuszu - użyj przycisku Synchronizuj.';
  if (status === 'not_configured') return 'Backup arkusza nie jest skonfigurowany.';
  return null;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}
