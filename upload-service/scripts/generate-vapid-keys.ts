// One-time setup for push notifications (pusher.ts): generates the VAPID key pair that signs
// every push the server sends. Not run in CI, not imported by the server.
//
// Usage:
//   cd upload-service
//   npx tsx scripts/generate-vapid-keys.ts
//
// It prints the gcloud commands that store the pair as the `vapid-public-key` and
// `vapid-private-key` Secret Manager secrets (read by deploy-upload-service.yml as
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY). Run them once, BEFORE the first deploy that references the
// secrets. Keys are printed only, never written to disk.
//
// Generate a new pair only if the private key leaks: every device then has to re-enable push in
// /profil/ (the page notices the key change and re-subscribes when the switch is turned on).
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const project = ` --project=${process.env.GCP_PROJECT ?? 'krucze-galery-upload'}`;

console.log(`# Klucz publiczny:  ${publicKey}`);
console.log('# Klucz prywatny jest tylko w poniższej komendzie - nie zapisuj go nigdzie indziej.\n');
console.log(`printf '%s' '${publicKey}' | gcloud secrets create vapid-public-key --data-file=-${project}`);
console.log(`printf '%s' '${privateKey}' | gcloud secrets create vapid-private-key --data-file=-${project}`);
