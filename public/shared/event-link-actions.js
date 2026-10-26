// Shared icon-only links and missing-link dialog for event cards and the event detail page.
(function () {
  const wiredContainers = new WeakSet();
  const LINK_INFO = {
    discordUrl: {
      label: 'Wątek na Discordzie',
      message: 'Nie podlinkowano tematu Discorda.',
      placeholder: 'https://discord.com/channels/…',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.2462.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.076.076 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
    },
    mapUrl: {
      label: 'Pinezka Google Maps z dojazdem',
      message: 'Nikt nie podał pinezki z dojazdem do Google Maps.',
      placeholder: 'https://maps.app.goo.gl/…',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.25 7.5 13.5 7.5 13.5S19.5 14.25 19.5 9A7.5 7.5 0 0 0 12 1.5z"/><circle cx="12" cy="9" r="3" fill="#fff"/></svg>',
    },
  };

  function escapeAttr(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function isUsableUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(String(value).trim());
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
    } catch {
      return false;
    }
  }

  function html(event) {
    return `<span class="lw-event-card-links">${Object.entries(LINK_INFO).map(([field, info]) => {
      const url = event[field];
      const usable = isUsableUrl(url);
      const accessibleLabel = usable
        ? (field === 'mapUrl' ? 'Otwórz pinezkę Google Maps' : 'Otwórz wątek na Discordzie')
        : (field === 'mapUrl' ? 'Dodaj pinezkę Google Maps' : 'Dodaj wątek na Discordzie');
      const tag = usable ? 'a' : 'button';
      const linkAttrs = usable
        ? ` href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"`
        : ' type="button" data-link-missing="true"';
      return `<${tag} class="lw-event-card-link lw-event-card-link--${field === 'discordUrl' ? 'discord' : 'map'}"${linkAttrs} data-event-link-field="${field}" aria-label="${accessibleLabel}" title="${accessibleLabel}">${info.icon}</${tag}>`;
    }).join('')}</span>`;
  }

  function openMissingLinkModal(field, event, saveLink) {
    if (document.getElementById('event-link-modal')) return;
    const info = LINK_INFO[field];
    if (!info) return;
    const root = document.createElement('div');
    root.id = 'event-link-modal';
    root.className = 'reauth-modal';
    root.innerHTML = `
      <div class="reauth-modal-dialog event-link-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="event-link-modal-title">
        <h2 class="reauth-modal-title" id="event-link-modal-title"></h2>
        <p class="notification-prompt-text">Możesz od razu wkleić link poniżej.</p>
        <div class="field">
          <label for="event-link-modal-input"></label>
          <input type="url" id="event-link-modal-input" inputmode="url" autocomplete="off">
        </div>
        <p class="add-album-error" id="event-link-modal-error" hidden></p>
        <div class="notification-prompt-actions">
          <button type="button" class="add-album-submit" id="event-link-modal-save">Zapisz link</button>
          <button type="button" class="btn-cancel" id="event-link-modal-cancel">Anuluj</button>
        </div>
      </div>`;
    root.querySelector('#event-link-modal-title').textContent = info.message;
    root.querySelector('label').textContent = info.label;
    const input = root.querySelector('#event-link-modal-input');
    input.placeholder = info.placeholder;
    const errorEl = root.querySelector('#event-link-modal-error');
    const onKeydown = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      root.remove();
    };
    root.querySelector('#event-link-modal-cancel').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    root.querySelector('#event-link-modal-save').addEventListener('click', async () => {
      const value = input.value.trim();
      if (!isUsableUrl(value)) {
        errorEl.textContent = 'Wpisz poprawny adres URL (https://…).';
        errorEl.hidden = false;
        return;
      }
      errorEl.hidden = true;
      try {
        await saveLink(event, field, value);
        close();
      } catch (err) {
        errorEl.textContent = `Nie udało się zapisać linku: ${err.message}`;
        errorEl.hidden = false;
      }
    });
    document.body.append(root);
    input.focus();
  }

  function wire(container, getEvent, saveLink) {
    if (wiredContainers.has(container)) return;
    wiredContainers.add(container);
    container.addEventListener('click', (e) => {
      const link = e.target.closest('[data-event-link-field]');
      if (!link || !container.contains(link) || link.dataset.linkMissing !== 'true') return;
      e.preventDefault();
      const event = getEvent(link.dataset.eventLinkField, link);
      if (event) openMissingLinkModal(link.dataset.eventLinkField, event, saveLink);
    });
  }

  window.EventLinkActions = { html, wire, openMissingLinkModal };
})();
