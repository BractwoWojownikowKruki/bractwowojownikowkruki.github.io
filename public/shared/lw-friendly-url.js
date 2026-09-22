/* Friendly event links (KRKG-0106). Slugs computed on-the-fly from event's current name+date.
   shareEvent() uses native Web Share API (mobile) with clipboard fallback (desktop). */
(function () {
  const DIACRITICS = {
    'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
  };

  function slugify(name) {
    const lower = String(name)
      .toLowerCase()
      .replace(/[ąćęłńóśźż]/g, (ch) => DIACRITICS[ch] ?? ch);
    return lower
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function eventSlug(event) {
    return `${event.startDate}-${slugify(event.name)}`;
  }

  function eventUrl(event) {
    return `https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=${eventSlug(event)}`;
  }

  async function shareEvent(event, { button, textEl } = {}) {
    const url = eventUrl(event);
    const shareData = { title: event.name, url };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return true;
      }
    } catch (err) {
      if (err.name === 'AbortError') return false; // user cancelled share sheet
      // AbortError means user cancelled; other errors mean share API is broken, fall through to clipboard
    }

    // Fallback: clipboard
    try {
      await navigator.clipboard.writeText(url);
      const originalText = textEl ? textEl.textContent : null;
      if (textEl) textEl.textContent = 'Skopiowano!';
      if (button) button.classList.add('lw-share--active');
      setTimeout(() => {
        if (textEl) textEl.textContent = originalText;
        if (button) button.classList.remove('lw-share--active');
      }, 2000);
      return true;
    } catch {
      return false;
    }
  }

  window.LwFriendlyUrl = { slugify, eventSlug, eventUrl, shareEvent };
})();
