function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Brak wymaganej zmiennej środowiskowej: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Published CSV export of a Sheet listing emails allowed into /admin (Viewer access via
  // link, editable only by Bartosz). See KRKG-0024 design.md for the pattern - no env
  // var/secret needed, this is a public read-only URL by design. Krucze Galerie's own
  // access/upload allowlist used to be a second Sheet like this one, but now shares
  // wojownicyUploadGroupUrl below instead (live Google Group membership, not a hand-edited
  // Sheet) - see the "same mechanism" gallery-auth migration.
  adminAllowlistSheetUrl: 'https://docs.google.com/spreadsheets/d/1StUp5mdTmbbuadc1XCOA_c2PILmYSAJ0Z5t1K7xjn78/export?format=csv',
  // Apps Script Web App deployed under the club's own Google account, returning
  // {"emails": [...]} for the live membership of the kruki Google Group (groups.google.com/g/kruki)
  // via GroupsApp - gates the self-service "Wrzucam swoje zdjęcie" upload in the Wojownicy
  // section to actual group members, kept in sync automatically instead of a manually-copied
  // Sheet. Public/unguessable URL by the same design as the two Sheet URls above - see
  // createAppsScriptAllowlist in allowlist.ts.
  wojownicyUploadGroupUrl: 'https://script.google.com/macros/s/AKfycbwkSGgWwYLq2XyGQSX7ntWh_PgvJ3ZTDV6NDRJ304wl0bkOJ3XyqKg1QjtWl5g5WYc7/exec',
  // Google Doc file IDs for the two Wojownicy-only pages (Zasady Bractwa, Poradnik Walki),
  // fetched live via drive.ts's exportDocHtml using docsClientId/docsClientSecret/docsRefreshToken
  // below - never checked out into the repo. IDs aren't secret in themselves: it's that
  // drive.file grant that gates access, not the ID's obscurity. Must be a native Google Doc, not
  // an uploaded .docx/.pdf/etc - Drive's export endpoint only converts its own native formats.
  // Re-run scripts/grant-docs-file-access.ts (picking the new file) whenever another doc needs
  // exposing here.
  wojownicyDocs: {
    'zasady-bractwa': '14jV4sHq8hbZSIJfDERNDTtuEmFCdzbAfn3xu42y4_P0',
    'poradnik-walki': '1ZbG5HMcj76twvrwakWaWunHlY_nQjx8r7aysoviZr4I',
  } as Record<string, string>,
  // A second, separate OAuth client - NOT driveClientId/driveClientSecret/driveRefreshToken
  // below, even though both are drive.file scope and the same Google account
  // (bractwo.wojownikow.kruki@gmail.com). Google Picker's mechanism for granting a drive.file
  // credential access to specific pre-existing files (rather than broadening to drive.readonly,
  // whole-Drive read access) requires a "Web application" type OAuth client with an Authorized
  // JavaScript origin - driveClientId is "Desktop" type and has no way to satisfy that, so its
  // Picker grants silently don't take effect (confirmed: files.get kept 404ing afterwards).
  // See scripts/grant-docs-file-access.ts and scripts/get-docs-refresh-token.ts for how this
  // credential and its per-file grants get set up. All three optional/undefined until that
  // one-time setup is done; server.ts falls back to the main Drive credential otherwise, which
  // 404s on any pre-existing file (not created via IT specifically) - so /wojownicy-docs just
  // fails closed rather than the whole service crashing at boot.
  docsClientId: process.env.DOCS_CLIENT_ID,
  docsClientSecret: process.env.DOCS_CLIENT_SECRET,
  docsRefreshToken: process.env.DOCS_REFRESH_TOKEN,
  // Same Apps Script pattern as wojownicyUploadGroupUrl above, but for a moderator group that
  // does not exist yet (see KRKG-0027) - gates destructive gallery actions (/delete-drive-gallery,
  // /unregister). Deliberately optional and undefined by default: until this is set to a real
  // group's Apps Script URL, createEmptyAllowlist denies every caller rather than either
  // blocking deploys on a secret that can't exist yet or leaving those endpoints open to the
  // whole kruki group in the meantime.
  moderatorGroupUrl: process.env.MODERATOR_GROUP_URL,
  googleOAuthClientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
  driveRefreshToken: requireEnv('DRIVE_REFRESH_TOKEN'),
  driveClientId: requireEnv('DRIVE_CLIENT_ID'),
  driveClientSecret: requireEnv('DRIVE_CLIENT_SECRET'),
  driveParentFolderId: requireEnv('DRIVE_PARENT_FOLDER_ID'),
  // How long GET /galleries serves its cached Drive listing before refreshing - see the
  // comment on ServerDeps.galleriesCacheTtlMs in server.ts for why this exists.
  galleriesCacheTtlMs: Number(process.env.GALLERIES_CACHE_TTL_MS ?? 10 * 60 * 1000),
  githubToken: requireEnv('GITHUB_TOKEN'),
  githubRepo: process.env.GITHUB_REPO ?? 'BractwoWojownikowKruki/bractwowojownikowkruki.github.io',
  // The site moved to a custom domain (www.kruki.org) - GitHub Pages now 301-redirects the old
  // bractwowojownikowkruki.github.io URL there, so no page ever actually runs client-side JS
  // from that origin anymore and it doesn't need to stay in the CORS allowlist too.
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? 'https://www.kruki.org',
  submissionTokenSecret: requireEnv('SUBMISSION_TOKEN_SECRET'),
  // 20 MB per photo - comfortably under Cloud Run's 32 MiB HTTP/1 request body limit,
  // with headroom for the multipart wrapper this service adds around each file.
  maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 20 * 1024 * 1024),
  // Checked exactly, in-process, before every /upload write (see server.ts's per-folder
  // reservation lock) and again unconditionally at /finalize as a backstop - bounds how large
  // a single album can grow, independent of per-request limits. No margin is needed: with
  // Cloud Run pinned to a single instance (Task 9), the in-process check is authoritative.
  maxFilesPerSubmission: Number(process.env.MAX_FILES_PER_SUBMISSION ?? 800),
  allowedMimeTypes: (process.env.ALLOWED_MIME_TYPES ?? 'image/jpeg,image/png,image/webp,image/heic,image/heif')
    .split(',')
    .map(t => t.trim()),
  // /start and /finalize read a small JSON body (name/date/folderId) - this bounds it well
  // above any legitimate payload so a public endpoint can't be made to buffer arbitrary bytes
  // before authentication even has a chance to reject the request.
  maxJsonBodyBytes: Number(process.env.MAX_JSON_BODY_BYTES ?? 8192),
};
