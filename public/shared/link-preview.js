// KRKG-124: Safe link parsing, domain recognition, and preview rendering for event descriptions.
//
// Converts raw URLs in event descriptions into secure, interactive HTML elements:
// - Standalone URLs on their own lines become compact smart chips (.lw-link-chip) with
//   recognized service icons (Google Maps, Drive, Facebook, YouTube, generic), service label,
//   and readable truncated URL.
// - Inline URLs inside sentences become styled inline links (.lw-link-inline) with an external arrow.
//
// Security guarantees:
// - Only http: and https: protocols are permitted (javascript: or data: URIs are ignored/rendered as text).
// - Strict DOM construction using document.createTextNode and safe elements (zero raw innerHTML on user input).
// - All links open safely in a new tab: target="_blank" and rel="noopener noreferrer".
(function () {
  const URL_REGEX = /https?:\/\/[^\s<>"'()]+(?:\([^\s<>"']*\)|[^\s<>"'.,:;!?(){}\[\]])/gi;

  const ICONS = {
    maps: '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    drive: '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
    facebook: '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>',
    youtube: '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>',
    external: '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    arrow: '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>',
  };

  function truncateString(str, maxLength) {
    if (!str || str.length <= maxLength) return str;
    return str.slice(0, maxLength - 1) + '…';
  }

  function formatDisplayUrl(parsed) {
    const host = parsed.host.replace(/^www\./, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const search = parsed.search ? parsed.search.slice(0, 15) : '';
    const full = host + path + search;
    return truncateString(full, 42);
  }

  /**
   * Classifies a URL into a recognizable service or fallback.
   * Returns null for unsupported protocols or invalid URLs.
   */
  function classifyUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

      // Google Maps
      if (
        host === 'maps.google.com' ||
        host === 'maps.app.goo.gl' ||
        (host === 'goo.gl' && parsed.pathname.startsWith('/maps')) ||
        (host === 'google.com' && parsed.pathname.startsWith('/maps'))
      ) {
        return {
          service: 'maps',
          label: 'Google Maps',
          displayUrl: formatDisplayUrl(parsed),
          href: parsed.href,
        };
      }

      // Google Drive / Docs / Sheets
      if (host === 'drive.google.com' || host === 'docs.google.com') {
        let label = 'Dysk Google';
        if (parsed.pathname.startsWith('/document')) label = 'Dokumenty Google';
        else if (parsed.pathname.startsWith('/spreadsheets')) label = 'Arkusze Google';
        else if (parsed.pathname.startsWith('/forms')) label = 'Formularze Google';
        return {
          service: 'drive',
          label,
          displayUrl: formatDisplayUrl(parsed),
          href: parsed.href,
        };
      }

      // Facebook
      if (
        host === 'facebook.com' ||
        host === 'm.facebook.com' ||
        host === 'fb.me' ||
        host === 'fb.com'
      ) {
        return {
          service: 'facebook',
          label: 'Facebook',
          displayUrl: formatDisplayUrl(parsed),
          href: parsed.href,
        };
      }

      // YouTube
      if (
        host === 'youtube.com' ||
        host === 'm.youtube.com' ||
        host === 'youtu.be'
      ) {
        return {
          service: 'youtube',
          label: 'YouTube',
          displayUrl: formatDisplayUrl(parsed),
          href: parsed.href,
        };
      }

      // Generic website
      return {
        service: 'generic',
        label: host,
        displayUrl: formatDisplayUrl(parsed),
        href: parsed.href,
      };
    } catch {
      return null;
    }
  }

  function createSvgElement(svgMarkup) {
    if (typeof document === 'undefined') return null;
    try {
      const template = document.createElement('template');
      if (template && template.content) {
        template.innerHTML = svgMarkup.trim();
        return template.content.firstChild;
      }
    } catch (_) {}
    const span = document.createElement('span');
    span.innerHTML = svgMarkup.trim();
    return span.firstChild || span;
  }

  /**
   * Builds a compact Smart Chip element (.lw-link-chip) for a standalone URL.
   */
  function createChipElement(info) {
    const a = document.createElement('a');
    a.className = `lw-link-chip lw-link-chip--${info.service}`;
    a.href = info.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    // Service icon container
    const iconSpan = document.createElement('span');
    iconSpan.className = 'lw-link-chip-icon';
    const svgEl = createSvgElement(ICONS[info.service] || ICONS.external);
    if (svgEl) iconSpan.appendChild(svgEl);
    a.appendChild(iconSpan);

    // Text content: Service Name • displayUrl
    const bodySpan = document.createElement('span');
    bodySpan.className = 'lw-link-chip-body';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'lw-link-chip-label';
    labelSpan.textContent = info.label;
    bodySpan.appendChild(labelSpan);

    const dotSpan = document.createElement('span');
    dotSpan.className = 'lw-link-chip-separator';
    dotSpan.textContent = '•';
    bodySpan.appendChild(dotSpan);

    const urlSpan = document.createElement('span');
    urlSpan.className = 'lw-link-chip-url';
    urlSpan.textContent = info.displayUrl;
    bodySpan.appendChild(urlSpan);

    a.appendChild(bodySpan);

    // Arrow indicator
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'lw-link-chip-arrow';
    const arrowSvg = createSvgElement(ICONS.arrow);
    if (arrowSvg) arrowSpan.appendChild(arrowSvg);
    a.appendChild(arrowSpan);

    return a;
  }

  /**
   * Builds an inline link element (.lw-link-inline) for a URL embedded within a sentence.
   */
  function createInlineLinkElement(info, rawMatch) {
    const a = document.createElement('a');
    a.className = `lw-link-inline lw-link-inline--${info.service}`;
    a.href = info.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    // Optional subtle service icon
    const iconSpan = document.createElement('span');
    iconSpan.className = 'lw-link-inline-icon';
    const svgEl = createSvgElement(ICONS[info.service] || ICONS.external);
    if (svgEl) iconSpan.appendChild(svgEl);
    a.appendChild(iconSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'lw-link-inline-text';
    textSpan.textContent = rawMatch;
    a.appendChild(textSpan);

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'lw-link-inline-arrow';
    const arrowSvg = createSvgElement(ICONS.arrow);
    if (arrowSvg) arrowSpan.appendChild(arrowSvg);
    a.appendChild(arrowSpan);

    return a;
  }

  /**
   * Safely parses raw text and renders text nodes, inline links, and chips into targetElement.
   */
  function renderInto(targetElement, text) {
    if (!targetElement) return;

    // Clear existing children safely
    while (targetElement.firstChild) {
      targetElement.removeChild(targetElement.firstChild);
    }

    if (!text) return;

    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        targetElement.appendChild(document.createTextNode('\n'));
      }

      const line = lines[i];
      const trimmed = line.trim();

      // Check if the trimmed line is exactly a single URL
      const lineMatches = [...trimmed.matchAll(new RegExp(URL_REGEX))];
      const isStandalone = lineMatches.length === 1 && lineMatches[0][0] === trimmed;
      const standaloneInfo = isStandalone ? classifyUrl(trimmed) : null;

      if (standaloneInfo) {
        // Line-leading indentation preservation if any
        const leadingWhitespace = line.match(/^\s*/)[0];
        if (leadingWhitespace) {
          targetElement.appendChild(document.createTextNode(leadingWhitespace));
        }

        targetElement.appendChild(createChipElement(standaloneInfo));

        const trailingWhitespace = line.match(/\s*$/)[0];
        if (trailingWhitespace) {
          targetElement.appendChild(document.createTextNode(trailingWhitespace));
        }
      } else {
        // Line contains mixed text and/or inline URLs
        let lastIndex = 0;
        let match;
        const regex = new RegExp(URL_REGEX);

        while ((match = regex.exec(line)) !== null) {
          const matchStart = match.index;
          const matchText = match[0];

          if (matchStart > lastIndex) {
            targetElement.appendChild(document.createTextNode(line.slice(lastIndex, matchStart)));
          }

          const info = classifyUrl(matchText);
          if (info) {
            targetElement.appendChild(createInlineLinkElement(info, matchText));
          } else {
            targetElement.appendChild(document.createTextNode(matchText));
          }

          lastIndex = matchStart + matchText.length;
        }

        if (lastIndex < line.length) {
          targetElement.appendChild(document.createTextNode(line.slice(lastIndex)));
        }
      }
    }
  }

  const api = {
    classifyUrl,
    createChipElement,
    createInlineLinkElement,
    renderInto,
    ICONS,
  };

  if (typeof window !== 'undefined') {
    window.LinkPreview = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.LinkPreview = api;
  }
})();
