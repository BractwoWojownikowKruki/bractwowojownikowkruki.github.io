window.addEventListener('load', () => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  void (async () => {
    const serviceWorker = navigator.serviceWorker;
    let shouldReloadOnControllerChange = Boolean(serviceWorker.controller);
    let reloaded = false;

    serviceWorker.addEventListener('controllerchange', () => {
      if (!shouldReloadOnControllerChange) {
        shouldReloadOnControllerChange = true;
        return;
      }
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    try {
      const registration = await serviceWorker.register('/service-worker.js', { updateViaCache: 'none' });
      await registration.update();
    } catch {}
  })();
});
