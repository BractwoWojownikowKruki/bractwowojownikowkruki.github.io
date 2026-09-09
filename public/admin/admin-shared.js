/**
 * Helpers shared by every admin panel page (Ogólne, Zgłoszenia, Zarządzanie ludźmi, Publiczne
 * wizytówki - KRKG-0049 split the panel from one page into these four). Load this before the
 * page's own script. Each page still wires its own initGoogleSignIn/admin-panel boilerplate and
 * #admin-reauth markup (same duplication pattern already used across the rest of this codebase's
 * pages), so showReauth/hideReauth below only need the DOM ids to exist, not any shared state.
 */
function showReauth() {
  const reauth = document.getElementById('admin-reauth');
  reauth.hidden = false;
  reauth.scrollIntoView({ block: 'center' });
}
function hideReauth() {
  document.getElementById('admin-reauth').hidden = true;
}

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

// Section/city color coding (KRKG-0051) - the colors themselves live in exactly one place,
// style.css's [data-section="..."] rules; this only ever emits the data-section attribute a CSS
// rule keys off, never a color value. A native <select> (Zarządzanie ludźmi's Sekcja dropdown)
// can't be color-coded internally, so this small swatch sits beside it instead.
function sectionDotHtml(sectionId) {
  return `<span class="section-dot" data-section="${escapeAttr(sectionId ?? '')}"></span>`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}
