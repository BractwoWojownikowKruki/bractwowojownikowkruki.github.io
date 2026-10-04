import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads public/people-photos.js (a browser global script) with a stubbed window/fetch.
function load(fetchImpl: (url: string) => Promise<unknown>) {
  const window: Record<string, any> = {};
  vm.runInNewContext(readFileSync(new URL('../public/people-photos.js', import.meta.url), 'utf8'), {
    window,
    fetch: fetchImpl,
    Math,
    Promise,
  });
  return window.PeoplePhotoCache;
}

const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });

test('loadStaticPeople reads /people-data/<slug>.json and marks photos as static', async () => {
  let requested = '';
  const cache = load(url => {
    requested = url;
    return ok({ version: 1, people: [{ name: 'A', order: 1, mainPhoto: { id: 'x', url: '/people-photos/x.jpg' }, photos: [] }] });
  });
  const people = await cache.loadStaticPeople('Założyciele');
  assert.equal(requested, '/people-data/zalozyciele.json');
  assert.equal(people[0].mainPhoto.fromStatic, true);
});

test('loadStaticPeople returns null (=> live API fallback) on 404, bad version, network error, unknown category', async () => {
  assert.equal(await load(() => Promise.resolve({ ok: false })).loadStaticPeople('Blachowi'), null);
  assert.equal(await load(() => ok({ version: 2, people: [] })).loadStaticPeople('Blachowi'), null);
  assert.equal(await load(() => Promise.reject(new Error('offline'))).loadStaticPeople('Blachowi'), null);
  assert.equal(await load(() => ok({ version: 1, people: [] })).loadStaticPeople('Inna'), null);
});

test('findStaticByFolderId resolves a person by public folder id once the snapshots are loaded', async () => {
  const person = { folderId: 'F1', name: 'Ania', order: 1, description: '', inMemoriam: false, mainPhoto: null, photos: [] };
  const cache = load(() => ok({ version: 1, people: [person] }));
  assert.equal(cache.findStaticByFolderId('F1'), null, 'not indexed until the snapshots have loaded');
  await cache.loadAllStaticPeople();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.findStaticByFolderId('F1')?.name, 'Ania');
  assert.equal(cache.findStaticByFolderId('nope'), null);
  assert.equal(cache.findStaticByFolderId(''), null);
});

// ---- Avatars: DOM upgrade of profile / equipment triggers ----
// A minimal DOM: just enough surface for the upgrade code (querySelectorAll over triggers,
// replaceWith / prepend / matches / dataset), driven synchronously through applyAvatars.
class FakeEl {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  listeners: Record<string, () => void> = {};
  dataset: Record<string, string>;
  constructor(public tag: string, public cls: string, attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_m, c) => c.toUpperCase())] = v;
  }
  add(child: FakeEl) { child.parent = this; this.children.push(child); return child; }
  hasAttribute(n: string) { return n in this.attrs; }
  setAttribute(n: string, v: string) { this.attrs[n] = v; }
  matches(sel: string) { return sel.split(',').map(x => x.trim()).some(c => (c.startsWith('.') && this.cls.split(' ').includes(c.slice(1))) || (c.startsWith('[') && c.endsWith(']') && c.slice(1, -1) in this.attrs)); }
  get previousElementSibling() { const i = this.parent!.children.indexOf(this); return i > 0 ? this.parent!.children[i - 1] : null; }
  get isConnected() { return this.parent !== null; }
  after(el: FakeEl) { const i = this.parent!.children.indexOf(this); el.parent = this.parent; this.parent!.children.splice(i + 1, 0, el); }
  before(el: FakeEl) { const i = this.parent!.children.indexOf(this); el.parent = this.parent; this.parent!.children.splice(i, 0, el); }
  style: Record<string, string> = {};
  get nextElementSibling() { const i = this.parent!.children.indexOf(this); return this.parent!.children[i + 1] ?? null; }
  querySelector(sel: string): FakeEl | null {
    const [tag, cls] = sel.split('.');
    return this.children.find(c => (!tag || c.tag === tag) && (!cls || c.cls.split(' ').includes(cls))) ?? null;
  }
  replaceWith(other: FakeEl) { const i = this.parent!.children.indexOf(this); other.parent = this.parent; this.parent!.children[i] = other; }
  prepend(child: FakeEl) { child.parent = this; this.children.unshift(child); }
  remove() { this.parent!.children = this.parent!.children.filter(c => c !== this); }
  addEventListener(name: string, fn: () => void) { this.listeners[name] = fn; }
  get className() { return this.cls; }
  set className(v: string) { this.cls = v; }
  src = ''; alt = ''; width = 0; height = 0; decoding = ''; loading = '';
}

function loadWithDom(triggers: FakeEl[], routes: Record<string, unknown>) {
  const window: Record<string, any> = {};
  const document = {
    body: {},
    querySelectorAll: (sel: string) => {
      const wantEquipment = sel.includes('data-equipment-trigger');
      return triggers.filter(t => !t.hasAttribute('data-avatar') && (t.hasAttribute('data-equipment-trigger') ? wantEquipment : t.hasAttribute('data-folder-id')));
    },
    createElement: (tag: string) => new FakeEl(tag, ''),
    addEventListener() {},
  };
  const fetchImpl = (url: string) => (url in routes ? ok(routes[url]) : Promise.resolve({ ok: false }));
  vm.runInNewContext(readFileSync(new URL('../public/people-photos.js', import.meta.url), 'utf8'), {
    window, document, fetch: fetchImpl, Math, Promise, setTimeout, Object, MutationObserver: undefined,
    Image: class { onload: () => void = () => {}; onerror: () => void = () => {}; set src(_v: string) { setImmediate(() => this.onload()); } },
  });
  return window.PeoplePhotoCache;
}

const SNAPSHOT = {
  version: 1,
  people: [
    { folderId: 'F1', name: 'Ania', avatar: { id: 'm1', url: '/people-photos/m1-64-aaaaaaaaaa.jpg' }, mainPhoto: null, photos: [] },
    { folderId: 'F2', name: 'Bez', avatar: null, mainPhoto: null, photos: [] },
  ],
};
const allSnapshots = Object.fromEntries(['zalozyciele', 'blachowi', 'niewiasty', 'emeryci', 'kandydaci'].map(s => [`/people-data/${s}.json`, s === 'blachowi' ? SNAPSHOT : { version: 1, people: [] }]));

test('personAvatarUrl resolves the cached avatar by folder id; null without avatar / unknown folder', async () => {
  const cache = loadWithDom([], allSnapshots);
  await cache.loadAllStaticPeople();
  await new Promise(r => setImmediate(r));
  assert.equal(cache.personAvatarUrl('F1'), '/people-photos/m1-64-aaaaaaaaaa.jpg');
  assert.equal(cache.personAvatarUrl('F2'), null);
  assert.equal(cache.personAvatarUrl('nope'), null);
});

test('the icon trigger swaps its svg for the avatar and restores it if the image fails; a missing avatar changes nothing', async () => {
  const wrap = new FakeEl('td', '');
  const svg = new FakeEl('svg', '');
  const iconBtn = wrap.add(new FakeEl('button', 'profile-trigger profile-trigger--icon-inline', { 'data-profile-trigger': '', 'data-folder-id': 'F1' }));
  iconBtn.add(svg);
  const noAvatarBtn = wrap.add(new FakeEl('button', 'profile-trigger profile-trigger--icon-inline', { 'data-profile-trigger': '', 'data-folder-id': 'F2' }));
  const noAvatarSvg = noAvatarBtn.add(new FakeEl('svg', ''));
  const cache = loadWithDom([iconBtn, noAvatarBtn], allSnapshots);
  await cache.loadAllStaticPeople();
  await new Promise(r => setImmediate(r));
  cache.applyAvatars();

  const img = iconBtn.children[0];
  assert.equal(img.tag, 'img');
  assert.equal(img.src, '/people-photos/m1-64-aaaaaaaaaa.jpg');
  assert.ok(img.cls.includes('person-avatar'));
  assert.ok(iconBtn.hasAttribute('data-avatar'));
  assert.equal(noAvatarBtn.children[0], noAvatarSvg, 'no cached avatar -> original icon stays');

  img.listeners.error();
  assert.equal(iconBtn.children[0], svg, 'a broken image falls back to the original icon');
});

test('a pill trigger without an icon button gets a trailing avatar; with an icon button next to it the icon takes it', async () => {
  const row = new FakeEl('td', '');
  const lone = row.add(new FakeEl('button', 'profile-trigger', { 'data-profile-trigger': '', 'data-folder-id': 'F1' }));
  lone.add(new FakeEl('span', 'category-name-pill'));
  const row2 = new FakeEl('td', '');
  const paired = row2.add(new FakeEl('button', 'profile-trigger', { 'data-profile-trigger': '', 'data-folder-id': 'F1' }));
  paired.add(new FakeEl('span', 'category-name-pill'));
  const iconBtn = row2.add(new FakeEl('button', 'profile-trigger profile-trigger--icon-inline', { 'data-profile-trigger': '', 'data-folder-id': 'F1' }));
  iconBtn.add(new FakeEl('svg', ''));
  const cache = loadWithDom([lone, paired, iconBtn], allSnapshots);
  await cache.loadAllStaticPeople();
  await new Promise(r => setImmediate(r));
  cache.applyAvatars();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  // The avatar is a background-image slot (no intrinsic height) placed right after the pill.
  assert.ok(lone.children[0].cls.includes('category-name-pill'));
  assert.equal(lone.children[1].tag, 'span');
  assert.ok(lone.children[1].cls.includes('person-avatar-slot'));
  assert.ok(lone.children[1].style.backgroundImage.includes('/people-photos/m1-64-aaaaaaaaaa.jpg'));
  assert.ok(paired.children[1].cls.includes('person-avatar-slot'), 'with an icon button next to it, the avatar still trails the pill');
  assert.ok(!row2.children.includes(iconBtn), 'the redundant icon button is removed once the avatar is placed');
});

test('an equipment pill swaps its image icon for the cached equipment avatar (photo id -> manifest)', async () => {
  const btn = new FakeEl('button', 'profile-trigger', { 'data-equipment-trigger': '', 'data-equipment-id': 'e1' });
  btn.add(new FakeEl('span', 'equipment-pill'));
  const icon = btn.add(new FakeEl('svg', 'equipment-photo-icon'));
  const other = new FakeEl('button', 'profile-trigger', { 'data-equipment-trigger': '', 'data-equipment-id': 'e2' });
  other.add(new FakeEl('svg', 'equipment-photo-icon'));
  const cache = loadWithDom([btn, other], {
    ...allSnapshots,
    '/people-data/equipment-avatars.json': { version: 1, items: { e1: 'p1' } },
    '/people-photos/manifest.json': { version: 1, photos: { p1: { v: '0', files: { '64': 'people-photos/p1-64-0.webp' } } } },
  });
  cache.applyAvatars(); // first pass: kicks off the (async) equipment lookup
  await cache.loadEquipmentAvatars();
  await new Promise(r => setImmediate(r));
  cache.applyAvatars();
  assert.equal(btn.children[0].tag, 'img', 'equipment avatar leads the pill, like a person avatar');
  assert.equal(btn.children[0].src, '/people-photos/p1-64-0.webp');
  assert.ok(btn.children[0].cls.includes('person-avatar--equipment'));
  assert.ok(!btn.children.includes(icon), 'the image icon is replaced');
  assert.equal(other.children[0].tag, 'svg', 'item without a cached avatar keeps its icon');
  btn.children[0].listeners.error();
  assert.ok(!btn.children.some(c => c.cls.includes('person-avatar--equipment')), 'a broken image is dropped');
});
