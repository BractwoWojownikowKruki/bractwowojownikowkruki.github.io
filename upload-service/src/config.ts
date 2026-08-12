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
  googleOAuthClientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
  driveRefreshToken: requireEnv('DRIVE_REFRESH_TOKEN'),
  driveClientId: requireEnv('DRIVE_CLIENT_ID'),
  driveClientSecret: requireEnv('DRIVE_CLIENT_SECRET'),
  driveParentFolderId: requireEnv('DRIVE_PARENT_FOLDER_ID'),
  githubToken: requireEnv('GITHUB_TOKEN'),
  githubRepo: process.env.GITHUB_REPO ?? 'BractwoWojownikowKruki/krucze-galery',
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
