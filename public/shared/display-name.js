// Single source of truth for "what do we call this member" (previously duplicated verbatim in
// wyjazd.js and skladki.js, which had already drifted apart once - one fell back to the raw email,
// the other didn't). Any page that lists members by name should include this script and call
// displayName(member) rather than keep its own copy.
//
// Priority: ksywka (nickname) wins when set - it's what most members actually go by - then imię i
// nazwisko (fullName), then the email's local part as a last resort for a member who has never
// opened "Mój profil" (the roster/directory endpoints enumerate the whole club allowlist, not just
// documented members).
//
// Whichever field wins can itself be an email by mistake (someone typed their address into "Imię i
// nazwisko" or "Ksywka" at some point) - stripEmailDomain runs on the final choice regardless of
// which field it came from, not just the true email fallback, so "jan.kowalski@gmail.com" never
// shows up verbatim in a name column no matter which field it leaked into.
function stripEmailDomain(value) {
  const at = value.indexOf('@');
  return at === -1 ? value : value.slice(0, at);
}

function displayName(member) {
  const chosen = member.nickname || member.fullName || member.email;
  return stripEmailDomain(chosen);
}
