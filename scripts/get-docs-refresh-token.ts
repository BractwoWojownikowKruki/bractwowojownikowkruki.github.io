/**
 * One-off tool: mints a new Google OAuth refresh token scoped to drive.readonly, for the same
 * OAuth client (and Google account, e.g. bractwowojownikowkruki@gmail.com) already used for the
 * drive.file-scoped DRIVE_REFRESH_TOKEN - see upload-service/src/config.ts's docsRefreshToken
 * comment for why a second, separate credential exists instead of broadening the first one.
 *
 * Runs the whole OAuth flow locally - no third-party tool (OAuth Playground etc.) involved, and
 * the authorization code never leaves this machine. Usage:
 *
 *   DRIVE_CLIENT_SECRET=... npx tsx scripts/get-docs-refresh-token.ts
 *
 * (DRIVE_CLIENT_ID is not a secret - it's already public in public/auth.js - so it's hardcoded
 * below rather than making you look it up too.)
 *
 * It prints a URL to open in a browser, waits for the redirect back to localhost, exchanges the
 * code for tokens, and prints ONLY the refresh token - pipe or copy that straight into
 * `gcloud secrets create docs-refresh-token --data-file=-`, never into a chat message.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const CLIENT_ID = '895090213384-cqac9v2tvmjhkkertjjj5q4h8qf41g3d.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET;
const PORT = 8091;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!CLIENT_SECRET) {
  console.error('Brak DRIVE_CLIENT_SECRET w środowisku. Uruchom tak:');
  console.error('  DRIVE_CLIENT_SECRET=... npx tsx scripts/get-docs-refresh-token.ts');
  console.error('(wartość: gcloud secrets versions access latest --secret=drive-oauth-client-secret --project=krucze-galery-upload)');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.readonly');
authUrl.searchParams.set('access_type', 'offline');
// Forces the consent screen (and therefore a refresh token) even if this Google account already
// granted this client some other scope before - without it, a previously-consented account can
// silently get no refresh token back at all on a repeat authorization.
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('state', state);

console.log('\n1. Musisz najpierw dodać ten adres jako "Authorized redirect URI" w Google Cloud Console');
console.log(`   (console.cloud.google.com/apis/credentials, ten sam klient co DRIVE_CLIENT_ID):\n`);
console.log(`   ${REDIRECT_URI}\n`);
console.log('2. Otwórz w przeglądarce (jako bractwowojownikowkruki@gmail.com) i zatwierdź zgodę:\n');
console.log(`   ${authUrl.toString()}\n`);
console.log('Czekam na przekierowanie z powrotem...\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Błąd autoryzacji: ${error}`);
    console.error(`Błąd autoryzacji: ${error}`);
    server.close();
    process.exit(1);
  }
  if (returnedState !== state || !code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nieprawidłowy state lub brak code.');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Gotowe, możesz wrócić do terminala.');
  server.close();

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    console.error(`Wymiana kodu na token nie powiodła się: HTTP ${tokenRes.status}`);
    console.error(await tokenRes.text());
    process.exit(1);
  }
  const data = (await tokenRes.json()) as { refresh_token?: string; access_token: string };
  if (!data.refresh_token) {
    console.error('Brak refresh_token w odpowiedzi - to konto mogło już wcześniej zgodzić się na ten sam zakres bez wymuszenia ekranu zgody.');
    console.error('Odwołaj dostęp tej aplikacji na myaccount.google.com/permissions i spróbuj ponownie.');
    process.exit(1);
  }

  console.log('\nRefresh token (nie wklejaj go na czacie - zapisz od razu jako sekret):\n');
  console.log(data.refresh_token);
  console.log('\nNp.:');
  console.log(`  echo -n "${data.refresh_token}" | gcloud secrets create docs-refresh-token --project=krucze-galery-upload --data-file=-\n`);
  process.exit(0);
});

server.listen(PORT);
