// Manual, one-time script. Run locally with production GCP credentials active:
//   cd upload-service && npx tsx scripts/seed-lookup-lists.ts
// Safe to re-run: it overwrites each lookupLists/{name} doc wholesale with this fixed
// list, sourced from the sheet's roster columns (design.md §3). Extend by adding items
// with "retired: false" — never delete a row a profile might already reference.
import { createFirestoreClient } from '../src/firestore.ts';

const client = createFirestoreClient();

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const sections = ['Bydgoszcz', 'Czukcze', 'Kraków', 'Poznań', 'Warszawa', 'Wrocław'].map((label) => ({
  id: slugify(label),
  label,
  retired: false,
}));
// migrate-existing-members.ts defaults an unrecognized member to sectionId "nieznana" - added
// here so the Sekcja dropdown (czlonkowie.js/profil.js) offers a proper "Nieznana" label for it
// instead of falling back to showing the raw id.
sections.push({ id: 'nieznana', label: 'Nieznana', retired: false });

const categories = ['Brokuł', 'Kandydat', 'Blacha', 'Thing', 'Niewiasta', 'Bobo', 'Inne'].map((label) => ({
  id: slugify(label),
  label,
  retired: false,
}));

const weapons = [
  { id: 'tarczownik', label: 'Tarczownik (T)' },
  { id: 'wlocznik', label: 'Włócznik (W)' },
  { id: 'dunczyk', label: 'Duńczyk (D)' },
].map((w) => ({ ...w, retired: false }));

await client.setDoc('lookupLists', 'sections', { items: sections });
await client.setDoc('lookupLists', 'categories', { items: categories });
await client.setDoc('lookupLists', 'weapons', { items: weapons });

console.log('Seeded lookupLists/{sections,categories,weapons}.');
