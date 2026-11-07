// Package the existing workspace, rather than maintaining a second viewer.
export const offlineAssets = ['/', '/style.css', '/theme.js', '/app.js', '/engine.js',
  '/presentation.js', '/syntax.js', '/vendor/highlight.js', '/project-model.js', '/offline.js', '/vendor/highlight.LICENSE', '/fonts/OFL.txt', '/fonts/AlbertSans.ttf'];

const jsonScript = value => JSON.stringify(value).replace(/</g, '\\u003c');
const base64 = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};

export async function collectOfflineAssets(fetchResource = fetch) {
  return Object.fromEntries(await Promise.all(offlineAssets.map(async path => {
    const response = await fetchResource(path);
    if (!response.ok) throw new Error(`离线资源读取失败：${path}（${response.status}），请刷新页面后重试。`);
    if (!path.endsWith('.ttf')) return [path, await response.text()];
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return [path, btoa(binary)];
  })));
}

export function offlineHtml(graph, resources, {scenario = null, theme = 'light'} = {}) {
  for (const path of offlineAssets) if (typeof resources[path] !== 'string' || !resources[path]) throw new Error(`缺少离线资源：${path}`);
  const imports = {};
  for (const path of offlineAssets.filter(path => path.endsWith('.js'))) {
    // Resolve static relative imports before moving modules to data URLs.
    const source = resources[path].replace(/\bfrom\s+(['"])(\.\.?\/[^'"]+)\1/g, (match, quote, specifier) => {
      const target = new URL(specifier, 'https://repo2tree.invalid' + path).pathname;
      if (!offlineAssets.includes(target)) throw new Error(`未打包的离线模块：${target}`);
      return `from ${quote}repo2tree${target}${quote}`;
    });
    imports['repo2tree' + path] = 'data:text/javascript;base64,' + base64(source);
  }
  const policy = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const boot = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script id="repo2tree-data" type="application/json">${jsonScript({graph, scenario, theme})}</script><script type="application/json" id="repo2tree-licenses">${jsonScript({highlight:resources['/vendor/highlight.LICENSE'], font:resources['/fonts/OFL.txt']})}</script>`;
  const style = resources['/style.css'].replace("url('/fonts/AlbertSans.ttf')", `url('data:font/ttf;base64,${resources['/fonts/AlbertSans.ttf']}')`);
  return resources['/']
    .replace('<script src="/theme.js"></script>', () => `${boot}<script>${resources['/theme.js']}</script>`)
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${style}</style>`)
    .replace('<script type="module" src="/app.js"></script>', () => `<script type="importmap">${jsonScript({imports})}</script><script type="module">import 'repo2tree/app.js';</script>`)
    .replace('href="/"', 'href="#"');
}
