// Single source of truth for "what do we call this member" (previously duplicated verbatim in
// wyjazd.js and skladki.js, which had already drifted apart once - one fell back to the raw email,
// the other didn't). Any page that lists members by name should include this script and call
// displayName(member) rather than keep its own copy.
//
// Priority (KRKG-0103): ksywka (nickname) wins when set, then imię (firstName), then nazwisko
// (lastName), then the email's local part as a last resort for a member who has never opened "Mój
// profil" (the roster/directory endpoints enumerate the whole club allowlist, not just documented
// members).
//
// Deliberately firstName ALONE (not "firstName lastName") once both are set: personSubline()
// below always renders the full "Nazwisko, Imię" underneath any name pill, so showing the full
// name again in the primary badge would just duplicate it. lastName is still its own fallback rung
// (not joined with firstName) for the window right after migrate-fullname-to-lastname.ts runs,
// when firstName is still '' but lastName holds the old, unsplit combined value - falling through
// to it (instead of stopping at firstName and showing nothing) keeps a legacy member's badge
// non-blank until an admin splits them.
//
// Whichever field wins can itself be an email by mistake (someone typed their address into a name
// field or "Ksywka" at some point) - stripEmailDomain runs on the final choice regardless of which
// field it came from, not just the true email fallback, so "jan.kowalski@gmail.com" never shows up
// verbatim in a name column no matter which field it leaked into.
function stripEmailDomain(value) {
  const safeValue = value || '';
  const at = safeValue.indexOf('@');
  return at === -1 ? safeValue : safeValue.slice(0, at);
}

function displayName(member) {
  const chosen = member.nickname || member.firstName || member.lastName || member.email;
  return stripEmailDomain(chosen);
}

// KRKG-0103: the small second line shown under a name pill - always the full "Nazwisko, Imię",
// regardless of what displayName() chose to show as the primary label. null when there is nothing
// worth showing (lastName blank - e.g. a member who has only ever filled in firstName by mistake,
// or an accountless person with only a ksywka), so the caller can omit the line entirely.
function personSubline(member) {
  const lastName = (member.lastName || '').trim();
  const firstName = (member.firstName || '').trim();
  if (lastName && firstName) return `${lastName}, ${firstName}`;
  if (lastName) return lastName;
  return null;
}
