// Browser-local preferences for the Lista wyjazdowa pages (KRKG-116). Remembers the checkbox
// choices that narrow a list - the Składki status filter (skladki.js's skladkiStatusFilter) and the
// trip roster view (wyjazd.js's Niezgłoszeni / Zgłoszeni + ja) - so they survive a reload.
//
// Storage is this browser's localStorage only: never the profile, never the server. The values are
// global, not per trip or per fee. Each key holds { v: LIST_PREFERENCES_VERSION, value: {...} }; a
// missing key, invalid JSON, another version, or a non-boolean field all read back as null, and the
// caller then keeps the page's own default. Storage can be blocked or throw (private mode), so every
// access is wrapped in try/catch: a failed read means "no saved value" and a failed write is dropped
// silently - the page still works, it just forgets the choice on the next visit.
//
// Callers pass the exact field names they expect; readBooleanPreference returns only a value that has
// every one of them as a boolean. A page restores its controls and its in-memory state from the result.

const LIST_PREFERENCES_VERSION = 1;

const LIST_PREFERENCE_KEYS = {
  skladkiStatusFilter: 'kruki_pref_skladki_status_filter',
  wyjazdRosterFilter: 'kruki_pref_wyjazd_roster_filter',
};

function readBooleanPreference(key, fieldNames) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== LIST_PREFERENCES_VERSION || !parsed.value || typeof parsed.value !== 'object') return null;
    const result = {};
    for (const name of fieldNames) {
      if (typeof parsed.value[name] !== 'boolean') return null;
      result[name] = parsed.value[name];
    }
    return result;
  } catch {
    // localStorage can throw in some privacy modes, and the stored text can be corrupt - either way
    // the page keeps its defaults.
    return null;
  }
}

function writeBooleanPreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: LIST_PREFERENCES_VERSION, value }));
  } catch {
    // localStorage can throw in some privacy modes - the choice simply isn't remembered.
  }
}
