// Apply the stored appearance before styles load, including when storage is unavailable.
(() => {
  const embedded = document.querySelector('#repo2tree-data');
  let theme = embedded ? JSON.parse(embedded.textContent).theme : 'light';
  try { if (localStorage.getItem('repo2tree:theme') === 'dark') theme = 'dark'; } catch { /* use the default light appearance */ }
  document.documentElement.dataset.theme = theme;
})();
