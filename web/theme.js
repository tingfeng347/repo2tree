// Apply the stored appearance before styles load, including when storage is unavailable.
(() => {
  let theme = 'light';
  try { if (localStorage.getItem('repo2tree:theme') === 'dark') theme = 'dark'; } catch { /* use the default light appearance */ }
  document.documentElement.dataset.theme = theme;
})();
