// Browser-local preferences for the Lista wyjazdowa and Spis Ludności pages (KRKG-116). Remembers the
// choices that narrow a list - the Składki status checkboxes (skladki.js's skladkiStatusFilter), the
// trip roster view (wyjazd.js's Niezgłoszeni / Zgłoszeni + ja) and the summary pill filters
// (summary-filter.js, one key per page type) - so they survive a reload.
//
// Storage is this browser's localStorage only: never the profile, never the server. The values are
// global per page type, not per trip, fee or page instance. Each key holds { v: LIST_PREFERENCES_VERSION,
// value: ... }; a missing key, invalid JSON, another version, or a value that fails the caller's check
// all read back as null, and the caller then keeps the page's own default. Storage can be blocked or
// throw (private mode), so every access is wrapped in try/catch: a failed read means "no saved value" and
// a failed write is dropped silently - the page still works, it just forgets the choice on the next visit.

const LIST_PREFERENCES_VERSION = 1;

const LIST_PREFERENCE_KEYS = {
  skladkiStatusFilter: 'kruki_pref_skladki_status_filter',
  wyjazdRosterFilter: 'kruki_pref_wyjazd_roster_filter',
  spisSummaryFilter: 'kruki_pref_spis_summary_filter',
  wyjazdSummaryFilter: 'kruki_pref_wyjazd_summary_filter',
  skladkiSummaryFilter: 'kruki_pref_skladki_summary_filter',
};

// Returns the stored value when it passes isValid, otherwise null. isValid receives the parsed value.
function readListPreferenceValue(key, isValid) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== LIST_PREFERENCES_VERSION || !isValid(parsed.value)) return null;
    return parsed.value;
  } catch {
    // localStorage can throw in some privacy modes, and the stored text can be corrupt - either way
    // the page keeps its defaults.
    return null;
  }
}

function writeListPreferenceValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: LIST_PREFERENCES_VERSION, value }));
  } catch {
    // localStorage can throw in some privacy modes - the choice simply isn't remembered.
  }
}

function isPlainObjectPreference(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The named boolean fields of a stored object, or null if any is missing or not a boolean. Extra
// stored fields are dropped.
function readBooleanPreference(key, fieldNames) {
  const value = readListPreferenceValue(key, (stored) =>
    isPlainObjectPreference(stored) && fieldNames.every((name) => typeof stored[name] === 'boolean'));
  if (!value) return null;
  const result = {};
  for (const name of fieldNames) result[name] = value[name];
  return result;
}

function writeBooleanPreference(key, value) {
  writeListPreferenceValue(key, value);
}
