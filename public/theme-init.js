// Runs before the body paints (a plain blocking script in <head>) so the
// dashboard never flashes the wrong theme. Kept in its own file because the
// panel's Content-Security-Policy forbids inline scripts.
(function () {
  var mode = 'system';
  try {
    mode = localStorage.getItem('pocket-theme') || 'system';
  } catch (error) {
    // Storage blocked: system default is fine.
  }

  var dark =
    mode === 'dark' ||
    (mode !== 'light' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
