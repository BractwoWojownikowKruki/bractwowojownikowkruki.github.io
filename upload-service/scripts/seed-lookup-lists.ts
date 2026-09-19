// Manual, one-time script. Run locally with production GCP credentials active:
//   cd upload-service && npx tsx scripts/seed-lookup-lists.ts [list...]
// Safe to re-run: it overwrites each named lookupLists/{name} doc wholesale with this fixed
// list, sourced from the sheet's roster columns (design.md §3). Extend by adding items
// with "retired: false" — never delete a row a profile might already reference.
//
// sections/categories/weapons are managed by editing Firestore directly in production once
// seeded (design.md §3 - that is the stated reason there is no admin UI for them), so running
// this script unscoped after the initial seed would silently clobber any such direct edit.
// Pass one or more list names as CLI args to scope the run to just those lists - e.g. after
// merging a change that only touches equipmentCategories:
//   npx tsx scripts/seed-lookup-lists.ts equipmentCategories
// With no args, every list is (re)seeded - the right default for a first-time/local/dev setup,
// never for a post-merge production run once sections/categories/weapons are live.
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

const categories = ['Brokuł', 'Kandydat', 'Blacha', 'Thing', 'Niewiasta', 'Bobo', 'Emeryt', 'Inne'].map((label) => ({
  id: slugify(label),
  label,
  retired: false,
}));

const weapons = [
  { id: 'tarczownik', label: 'Tarczownik (T)' },
  { id: 'wlocznik', label: 'Włócznik (W)' },
  { id: 'dunczyk', label: 'Duńczyk (D)' },
].map((w) => ({ ...w, retired: false }));

const equipmentCategories = [
  { id: 'namiot', label: 'Namiot', retired: false },
  { id: 'wiata', label: 'Wiata', retired: false },
];

const SEEDS: Record<string, { id: string; label: string; retired: boolean }[]> = {
  sections,
  categories,
  weapons,
  equipmentCategories,
};
const LIST_NAMES = Object.keys(SEEDS);

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!(name in SEEDS)) {
    console.error(`Unknown lookup list "${name}". Known lists: ${LIST_NAMES.join(', ')}.`);
    process.exit(1);
  }
}
const namesToSeed = requested.length ? requested : LIST_NAMES;

for (const name of namesToSeed) {
  await client.setDoc('lookupLists', name, { items: SEEDS[name] });
}

console.log(`Seeded lookupLists/{${namesToSeed.join(',')}}.`);
