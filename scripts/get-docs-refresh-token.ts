/**
 * One-off tool: mints a refresh token (drive.file scope) for the DEDICATED "Docs Picker" Web
 * OAuth client - a separate client from DRIVE_CLIENT_ID (which is Desktop-type and, it turns
 * out, incompatible with Google Picker's per-file drive.file grant mechanism - Picker requires
 * a Web application client with an Authorized JavaScript origin to register a grant correctly).
 *
 * This refresh token is for the BACKEND side: upload-service uses it (config.ts's
 * docsRefreshToken) to call Drive's export endpoint for whichever files get granted via
 * scripts/grant-docs-file-access.ts (which does the actual Picker step, in-browser, using this
 * same client's public Client ID). Scope is drive.file, same narrow scope as the main
 * DRIVE_REFRESH_TOKEN - just a different, isolated client identity, so the grant Picker
 * registers under this client is one this refresh token can actually use.
 *
 * Usage:
 *   DOCS_CLIENT_ID=... DOCS_CLIENT_SECRET=... npx tsx scripts/get-docs-refresh-token.ts
 *
 * Requires the Web client to have "http://localhost:8091/callback" as an Authorized redirect
 * URI (Web clients need this registered explicitly, unlike Desktop clients' automatic loopback
 * exemption) - see the setup steps this prints if run without the client already configured
 * correctly (you'll get a redirect_uri_mismatch error from Google in that case).
 *
 * Prints ONLY the refresh token - pipe or copy that straight into
 * `gcloud secrets create docs-refresh-token --data-file=-`, never into a chat message.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const CLIENT_ID = process.env.DOCS_CLIENT_ID;
const CLIENT_SECRET = process.env.DOCS_CLIENT_SECRET;
const PORT = 8091;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Brak DOCS_CLIENT_ID lub DOCS_CLIENT_SECRET w środowisku. Uruchom tak:');
  console.error('  DOCS_CLIENT_ID=... DOCS_CLIENT_SECRET=... npx tsx scripts/get-docs-refresh-token.ts');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file');
authUrl.searchParams.set('access_type', 'offline');
// Forces the consent screen (and therefore a refresh token) even if this Google account already
// granted this client some other scope before - without it, a previously-consented account can
// silently get no refresh token back at all on a repeat authorization.
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('state', state);

console.log('\nOtwórz w przeglądarce (jako bractwo.wojownikow.kruki@gmail.com) i zatwierdź zgodę:\n');
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
      client_id: CLIENT_ID!,
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
