/**
 * Swaps Google Drive thumbnail URLs for the statically cached copies in /people-photos/, when
 * the nightly "Sync people photos" job (scripts/sync-people-photos.ts) has stored them.
 *
 * The backend API stays the source of truth for *which* photos a person has; this only decides
 * *where each image is loaded from*. A photo uses its cached copy only if the manifest has that
 * exact Drive file id at the needed size AND (when the API reports a checksum) the cached
 * version matches it. Anything else - new upload, edited photo, missing manifest, any error -
 * silently keeps its Drive URL, so this can never make a page worse than it was.
 *
 * The cached copy replaces `url`; the original Drive URL is kept as `remoteUrl`, because the
 * 1600px lightbox size is intentionally not cached and still has to come from Drive.
 */
window.PeoplePhotoCache = (function () {
  const MANIFEST_URL = '/people-photos/manifest.json';
  let manifestPromise = null;

  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
        .then((res) => (res.ok ? res.json() : null))
        .then((m) => (m && m.version === 1 && m.photos ? m.photos : null))
        .catch(() => null);
    }
    return manifestPromise;
  }

  function cached(photo, manifest) {
    if (!photo || !photo.url || !manifest) return photo;
    const size = (/=s(\d+)$/.exec(photo.url) || [])[1];
    const entry = manifest[photo.id];
    const file = entry && size && entry.files[size];
    if (!file) return photo;
    if (photo.md5 && photo.md5.slice(0, 10).toLowerCase() !== entry.v) return photo;
    return { ...photo, url: '/' + file, remoteUrl: photo.url };
  }

  // people: the /about-us people array. Returns a new array; the input is not mutated.
  async function applyToPeople(people) {
    const manifest = await loadManifest();
    return people.map((p) => ({
      ...p,
      mainPhoto: cached(p.mainPhoto, manifest),
      photos: (p.photos || []).map((ph) => cached(ph, manifest)),
    }));
  }

  // profile: a /member-profile response. Only the published mainPhoto/photos are swapped;
  // pendingPhotos (unapproved uploads) are never in the cache and always come from Drive.
  async function applyToProfile(profile) {
    if (!profile || (!profile.mainPhoto && !(profile.photos || []).length)) return profile;
    const manifest = await loadManifest();
    return {
      ...profile,
      mainPhoto: cached(profile.mainPhoto, manifest),
      photos: (profile.photos || []).map((ph) => cached(ph, manifest)),
    };
  }

  // ---- Static people snapshot (public/people-data/<slug>.json) ----
  // Written by the same nightly/triggered job. Same file names as the category pages
  // (scripts/people-photos-utils.ts CATEGORY_SLUGS).
  const CATEGORY_SLUGS = {
    'Założyciele': 'zalozyciele',
    Blachowi: 'blachowi',
    Niewiasty: 'niewiasty',
    Emeryci: 'emeryci',
    Kandydaci: 'kandydaci',
  };

  // Resolves to a people array (photos marked fromStatic) or null on any problem, in which case
  // the caller falls back to the live API.
  async function loadStaticPeople(category) {
    const slug = CATEGORY_SLUGS[category];
    if (!slug) return null;
    try {
      const res = await fetch(`/people-data/${slug}.json`, { cache: 'no-cache' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.version !== 1 || !Array.isArray(data.people)) return null;
      const mark = (p) => (p ? { ...p, fromStatic: true } : null);
      return data.people.map((p) => ({ ...p, mainPhoto: mark(p.mainPhoto), photos: (p.photos || []).map(mark) }));
    } catch {
      return null;
    }
  }

  // ---- Instant preview for the profile drawer ----
  // The drawer needs *something* to show before /member-profile answers. The static snapshots
  // carry no e-mail (they are public), so a person is looked up by their public About-Us folder
  // id, which the trigger carries (data-folder-id). No folder id / no match returns null and the
  // drawer shows a placeholder until the API answers. The API response always replaces this.
  let allStaticPromise = null;

  function loadAllStaticPeople() {
    if (!allStaticPromise) {
      allStaticPromise = Promise.all(Object.keys(CATEGORY_SLUGS).map((c) => loadStaticPeople(c)))
        .then((lists) => lists.flatMap((l) => l || []));
    }
    return allStaticPromise;
  }

  // Synchronous once loadAllStaticPeople() has resolved (warmed up on page load).
  let staticByFolderId = null;
  function indexStatic(people) {
    staticByFolderId = new Map();
    for (const p of people) if (p.folderId) staticByFolderId.set(p.folderId, p);
  }
  loadAllStaticPeople().then(indexStatic);

  function findStaticByFolderId(folderId) {
    if (!staticByFolderId || !folderId) return null;
    return staticByFolderId.get(folderId) || null;
  }

  // ---- Avatars in name pills / equipment pills ----
  // A small round picture replaces the generic person icon (and the equipment image icon) wherever
  // a pill's trigger button is rendered. Everything is static: persons come from the snapshot's
  // `avatar` (looked up by the trigger's data-folder-id), equipment from
  // /people-data/equipment-avatars.json + the photo manifest. Nothing here ever asks Google Drive
  // or the backend, and anything missing (no folder id, no cached avatar, a failed image load)
  // simply leaves the original icon in place.
  //
  // Pages render their tables with innerHTML at arbitrary moments, and the snapshots load
  // asynchronously, so instead of touching every page's renderer a MutationObserver upgrades
  // triggers as they appear (and once more when the data arrives). A trigger that was upgraded is
  // marked data-avatar so it is never processed twice.
  const ICON_TRIGGER = '.profile-trigger--icon-inline, .profile-trigger--icon';
  const AVATAR_TRIGGERS = '[data-profile-trigger][data-folder-id]:not([data-avatar]), [data-equipment-trigger][data-equipment-id]:not([data-avatar])';

  let equipmentAvatarsPromise = null;
  let equipmentAvatars = null; // equipment id -> url, once loaded

  function loadEquipmentAvatars() {
    if (!equipmentAvatarsPromise) {
      equipmentAvatarsPromise = Promise.all([
        fetch('/people-data/equipment-avatars.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
        loadManifest(),
      ])
        .then(([data, manifest]) => {
          const map = new Map();
          if (data && data.version === 1 && data.items && manifest) {
            for (const [equipmentId, photoId] of Object.entries(data.items)) {
              const file = manifest[photoId] && manifest[photoId].files && manifest[photoId].files['64'];
              if (file) map.set(equipmentId, '/' + file);
            }
          }
          return map;
        })
        .catch(() => new Map())
        .then((map) => {
          equipmentAvatars = map;
          return map;
        });
    }
    return equipmentAvatarsPromise;
  }

  function personAvatarUrl(folderId) {
    const person = findStaticByFolderId(folderId);
    return person && person.avatar && person.avatar.url ? person.avatar.url : null;
  }

  function makeAvatar(url, modifier) {
    const img = document.createElement('img');
    img.className = 'person-avatar' + (modifier ? ' ' + modifier : '');
    img.src = url;
    img.alt = '';
    img.width = 64;
    img.height = 64;
    img.decoding = 'async';
    img.loading = 'lazy';
    return img;
  }

  function upgradeTrigger(trigger) {
    if (trigger.hasAttribute('data-equipment-trigger')) {
      const url = equipmentAvatars && equipmentAvatars.get(trigger.dataset.equipmentId);
      const icon = trigger.querySelector('svg.equipment-photo-icon');
      if (!url || !icon) return;
      const img = makeAvatar(url, 'person-avatar--equipment');
      img.addEventListener('error', () => img.replaceWith(icon), { once: true });
      icon.replaceWith(img);
      trigger.setAttribute('data-avatar', '');
      return;
    }
    const url = personAvatarUrl(trigger.dataset.folderId);
    if (!url) return;
    if (trigger.matches(ICON_TRIGGER)) {
      // Next to a name pill (Lista Wyjazdowa, Spis Ludności): the avatar sits flush against the
      // pill's left edge and replaces the redundant "show profile" icon button.
      const pillTrigger = trigger.previousElementSibling;
      const pill = pillTrigger && pillTrigger.matches('[data-profile-trigger]') ? pillTrigger.querySelector('.category-name-pill') : null;
      if (pill) {
        const img = makeAvatar(url, 'person-avatar--lead');
        img.addEventListener('error', () => img.remove(), { once: true });
        pill.before(img);
        pillTrigger.setAttribute('data-avatar', '');
        trigger.remove();
        return;
      }
      const icon = trigger.querySelector('svg');
      if (!icon) return;
      const img = makeAvatar(url, 'person-avatar--icon');
      img.addEventListener('error', () => img.replaceWith(icon), { once: true });
      icon.replaceWith(img);
    } else {
      // A pill with no "show profile" icon next to it (owner cells, Pliki, ...): the avatar leads
      // the pill instead. When an icon trigger follows, that one carries the avatar.
      const next = trigger.nextElementSibling;
      if (next && next.matches(ICON_TRIGGER)) return;
      const img = makeAvatar(url, 'person-avatar--lead');
      img.addEventListener('error', () => img.remove(), { once: true });
      trigger.prepend(img);
    }
    trigger.setAttribute('data-avatar', '');
  }

  function applyAvatars() {
    if (typeof document === 'undefined') return;
    const triggers = document.querySelectorAll(AVATAR_TRIGGERS);
    if (!triggers.length) return;
    if (!equipmentAvatars && [...triggers].some((t) => t.hasAttribute('data-equipment-trigger'))) {
      loadEquipmentAvatars().then(applyAvatars);
    }
    triggers.forEach(upgradeTrigger);
  }

  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        applyAvatars();
      }, 0);
    };
    const start = () => {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
      loadAllStaticPeople().then(() => {
        // indexStatic (registered earlier on the same promise) has already run.
        applyAvatars();
      });
      schedule();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  return { applyToPeople, applyToProfile, loadStaticPeople, loadAllStaticPeople, findStaticByFolderId, personAvatarUrl, loadEquipmentAvatars, applyAvatars };
})();
