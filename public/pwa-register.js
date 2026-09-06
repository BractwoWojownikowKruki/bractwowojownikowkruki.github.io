window.addEventListener('load', () => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  void (async () => {
    const serviceWorker = navigator.serviceWorker;
    const hadControllerAtStart = Boolean(serviceWorker.controller);
    let reloaded = false;

    serviceWorker.addEventListener('controllerchange', () => {
      if (!hadControllerAtStart || reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    try {
      const registration = await serviceWorker.register('/service-worker.js', { updateViaCache: 'none' });
      await registration.update();
    } catch {}
  })();
});
