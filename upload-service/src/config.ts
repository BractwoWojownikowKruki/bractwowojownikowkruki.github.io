function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Brak wymaganej zmiennej środowiskowej: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Published CSV export of the allowlist Sheet Bartosz manages directly (Viewer access via
  // link, editable only by him). See KRKG-0024 design.md - no env var/secret needed, this is
  // a public read-only URL by design.
  allowlistSheetUrl: 'https://docs.google.com/spreadsheets/d/1QH_OElOz3-_YbK71D_0gjX4P5OYJMjuS0zv0J5lL3dY/export?format=csv',
  // Published CSV export of a second Sheet, listing emails allowed into /admin. Same pattern
  // and same phone-manageable editing story as allowlistSheetUrl above (KRKG-0024) - just a
  // different Sheet.
  adminAllowlistSheetUrl: 'https://docs.google.com/spreadsheets/d/1StUp5mdTmbbuadc1XCOA_c2PILmYSAJ0Z5t1K7xjn78/export?format=csv',
  // Apps Script Web App deployed under the club's own Google account, returning
  // {"emails": [...]} for the live membership of the kruki Google Group (groups.google.com/g/kruki)
  // via GroupsApp - gates the self-service "Wrzucam swoje zdjęcie" upload in the Wojownicy
  // section to actual group members, kept in sync automatically instead of a manually-copied
  // Sheet. Public/unguessable URL by the same design as the two Sheet URls above - see
  // createAppsScriptAllowlist in allowlist.ts.
  wojownicyUploadGroupUrl: 'https://script.google.com/macros/s/AKfycbwkSGgWwYLq2XyGQSX7ntWh_PgvJ3ZTDV6NDRJ304wl0bkOJ3XyqKg1QjtWl5g5WYc7/exec',
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
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? 'https://bractwowojownikowkruki.github.io',
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
