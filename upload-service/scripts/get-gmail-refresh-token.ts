// One-time interactive OAuth setup for e-mail notifications (mailer.ts). Same flow as
// get-sheets-refresh-token.ts, and it reuses that script's "Web application" OAuth client
// (SHEETS_CLIENT_ID/SHEETS_CLIENT_SECRET) - only the scope differs: gmail.send, which can send
// mail as the account but never read the mailbox. Not run in CI, not imported by the server.
//
// Prerequisites:
//   1. In Google Cloud Console (the same project as the other OAuth clients), enable the Gmail API.
//   2. On the OAuth consent screen, add the https://www.googleapis.com/auth/gmail.send scope.
//   3. Sign in as bractwo.wojownikow.kruki@gmail.com when the consent screen opens - every
//      notification is sent from that account.
//
// Usage:
//   cd upload-service
//   SHEETS_CLIENT_ID=... SHEETS_CLIENT_SECRET=... npx tsx scripts/get-gmail-refresh-token.ts
//
// Then store the printed value as the `gmail-refresh-token` Secret Manager secret (read by
// deploy-upload-service.yml as GMAIL_REFRESH_TOKEN). It is printed only, never written to disk.
import { createServer } from 'node:http';

const REDIRECT_URI = 'http://localhost:8991/oauth2callback';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Brak wymaganej zmiennej środowiskowej: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const clientId = requireEnv('SHEETS_CLIENT_ID');
  const clientSecret = requireEnv('SHEETS_CLIENT_SECRET');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // forces a refresh token even on repeat consent

  console.log('Otwórz ten adres w przeglądarce (zaloguj się jako bractwo.wojownikow.kruki@gmail.com):\n');
  console.log(authUrl.toString());
  console.log('\nCzekam na przekierowanie na http://localhost:8991/oauth2callback ...');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const receivedCode = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error ? `Błąd: ${error}. Można zamknąć tę kartę.` : 'Zalogowano. Można zamknąć tę kartę i wrócić do terminala.');
      server.close();
      if (error) reject(new Error(error));
      else if (receivedCode) resolve(receivedCode);
      else reject(new Error('Brak kodu autoryzacyjnego w odpowiedzi.'));
    });
    server.listen(8991);
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  if (!tokenRes.ok) {
    console.error(`Wymiana kodu na token nie powiodła się: HTTP ${tokenRes.status}`, await tokenRes.text());
    process.exit(1);
  }
  const body = (await tokenRes.json()) as { refresh_token?: string; access_token: string };
  if (!body.refresh_token) {
    console.error(
      'Odpowiedź nie zawiera refresh_token - to konto mogło już wcześniej wydać zgodę bez access_type=offline. ' +
        'Odwołaj dostęp aplikacji w ustawieniach konta Google (myaccount.google.com/permissions) i uruchom skrypt ponownie.',
    );
    process.exit(1);
  }

  console.log('\nGMAIL_REFRESH_TOKEN=' + body.refresh_token);
  console.log('\nZapisz tę wartość jako sekret gmail-refresh-token (patrz deploy-upload-service.yml).');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
