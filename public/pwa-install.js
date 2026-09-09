(() => {
  const controls = [...document.querySelectorAll('[data-pwa-install]')];
  const messages = [...document.querySelectorAll('[data-pwa-install-message]')];
  let deferredPrompt;
  let installed = false;

  const hideInstallUi = () => {
    controls.forEach(control => { control.hidden = true; });
    messages.forEach(message => { message.hidden = true; });
  };

  const showControls = () => {
    controls.forEach(control => { control.hidden = false; });
  };

  const setControlsDisabled = disabled => {
    controls.forEach(control => { control.disabled = disabled; });
  };

  const hideMessages = () => {
    messages.forEach(message => { message.hidden = true; });
  };

  const showGuidance = text => {
    messages.forEach(message => {
      message.textContent = text;
      message.hidden = false;
    });
  };

  const isPwaEligible = document.querySelector('link[rel="manifest"][href="/manifest.webmanifest"]') !== null;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (!isPwaEligible || isStandalone) {
    hideInstallUi();
    return;
  }

  showControls();

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    showControls();
    hideMessages();
  });

  window.addEventListener('appinstalled', async () => {
    installed = true;
    deferredPrompt = undefined;
    hideInstallUi();
    try {
      await apiFetch('/application/pwa-installation', { method: 'POST' });
    } catch {
      // Installation is already complete in the browser. A transient audit-report failure must
      // not undo that state or show a misleading installation error to the member.
    }
  });

  controls.forEach(control => {
    control.addEventListener('click', async event => {
      event.preventDefault();

      if (installed) return;

      if (!deferredPrompt) {
        showGuidance(isAppleMobile
          ? 'Udostępnij → Dodaj do ekranu początkowego'
          : 'Otwórz menu przeglądarki i wybierz „Zainstaluj aplikację”.');
        return;
      }

      const promptEvent = deferredPrompt;
      deferredPrompt = undefined;
      setControlsDisabled(true);

      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;

        if (choice.outcome === 'dismissed') {
          showControls();
          showGuidance('Otwórz menu przeglądarki i wybierz „Zainstaluj aplikację”.');
        }
      } catch {
        showControls();
        showGuidance('Otwórz menu przeglądarki i wybierz „Zainstaluj aplikację”.');
      } finally {
        if (!installed) setControlsDisabled(false);
      }
    });
  });
})();
