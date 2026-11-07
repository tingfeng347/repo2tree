import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {offlineAssets, collectOfflineAssets, offlineHtml} from '../web/offline.js';
const resources = Object.fromEntries(offlineAssets.map(path => [path, path.endsWith('.ttf') ? readFileSync(new URL('../web' + path, import.meta.url)).toString('base64') : readFileSync(new URL('../web' + (path === '/' ? '/index.html' : path), import.meta.url), 'utf8')]));
const graph = JSON.parse(readFileSync(new URL('../examples/demo.project.json', import.meta.url)));
const embedded = (html, id) => JSON.parse(html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))[1]);

test('offline document packages the real modules, font, source snapshot and selected scenario', () => {
  const scenario = JSON.parse(readFileSync(new URL('../examples/scenarios/order-success.json', import.meta.url)));
  const html = offlineHtml(graph, resources, {scenario, theme:'dark'});
  assert.deepEqual(embedded(html, 'repo2tree-data'), {graph, scenario, theme:'dark'});
  const map = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/)[1]);
  for (const path of offlineAssets.filter(p => p.endsWith('.js'))) {
    const uri = map.imports['repo2tree' + path];
    const source = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      // Only static import/export declarations matter; source text includes example strings.
      if (match[1].startsWith('repo2tree/')) assert(map.imports[match[1]], match[1]);
    }
    assert(!/^import .* from ['"]\./m.test(source), path);
  }
  assert(!html.includes('src="/app.js"'));
  assert(!html.includes('href="/style.css"'));
  assert(!html.includes("url('/fonts/AlbertSans.ttf')"));
  assert(html.includes('data:font/ttf;base64,'));
  assert(html.includes("connect-src 'none'"));
  assert(html.includes('SIL OPEN FONT LICENSE'));
});

test('source text cannot close the embedded script or trigger replacement-string substitution', () => {
  const hostile = structuredClone(graph);
  hostile.project.name = '</script><script>globalThis.injected=true</script> $& $$ $`';
  hostile.sources['payload.js'] = '<img src=x onerror=alert(1)>\u2028中文';
  const html = offlineHtml(hostile, resources);
  assert.deepEqual(embedded(html, 'repo2tree-data').graph, hostile);
  assert(!html.includes('<script>globalThis.injected=true</script>'));
});

test('a missing resource or failed fetch fails the whole export', async () => {
  const missing = {...resources}; delete missing['/engine.js'];
  assert.throws(() => offlineHtml(graph, missing), /缺少离线资源/);
  await assert.rejects(collectOfflineAssets(async () => new Response('missing', {status:404})), /离线资源读取失败/);
});
