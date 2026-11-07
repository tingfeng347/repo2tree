// Real-browser integration, isolated Chrome profile. Requires an already running repo2tree server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:7331';
const shots = resolve(process.argv[3] || '.impeccable/review/map-refactor');
mkdirSync(shots, {recursive:true});
const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
assert(chrome, 'Chrome is required; set CHROME');
const profile = mkdtempSync(join(tmpdir(), 'repo2tree-browser-'));
const port = 9500 + Math.floor(Math.random() * 1000);
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page'); } catch {} if (!target) await delay(100); }
  assert(target, 'Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let serial = 0; const pending = new Map(), exceptions = [];
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000); pending.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('UI condition timed out: ' + expression);
  };
  const screenshot = async name => {
    const screen = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:true});
    writeFileSync(join(shots, name + '.png'), Buffer.from(screen.data, 'base64'));
  };
  await send('Page.navigate', {url});
  await waitFor(`document.querySelector('#project-name')?.textContent === 'shop'`);
  await evaluate(`document.querySelector('#entries .frontend').closest('button').click()`);
  assert(await evaluate(`document.querySelector('#tree .selected')?.textContent.includes('OrderPage')`));
  await evaluate(`document.querySelector('[data-view="calls"]').click()`);
  await evaluate(`document.querySelector('#atlas [data-symbol]').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
  assert(await evaluate(`document.querySelector('#tree .selected')?.dataset.symbol === document.querySelector('#atlas .selected')?.dataset.symbol`));

  // Selecting a symbol beyond a lazy tree page must expand the correct ancestry.
  const large = JSON.parse(readFileSync(new URL('../examples/demo.project.json', import.meta.url)));
  const file = large.nodes.find(n => n.path === 'frontend/App.tsx' && n.kind === 'file');
  for (let i=0; i<650; i++) large.nodes.push({id:`extra-${i}`, name:`zz_extra_${String(i).padStart(3,'0')}`, kind:'function', parent:file.id, path:file.path, line:1, endLine:1, flowStatus:'unsupported'});
  large.nodes.push({id:'orphan',name:'orphan',kind:'function',parent:'missing',path:file.path,line:1,endLine:1}, {id:'hidden-parent',name:'metadata',kind:'variable',parent:file.id}, {id:'hidden-child',name:'hidden_child',kind:'function',parent:'hidden-parent',path:file.path,line:1,endLine:1});
  large.entries.push({id:'extra-649', label:'zz_extra_649', kind:'function'});
  const importSnapshot = async snapshot => {
    await evaluate(`(() => {const input=document.querySelector('#project-import');const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(snapshot))}], 'project.json', {type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
    await waitFor(`document.querySelector('#project-import').value === ''`);
  };
  await importSnapshot(large);
  await evaluate(`document.querySelector('#search').value='zz_extra_649';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('#entries [data-entry]').click()`);
  assert.equal(await evaluate(`document.querySelector('#tree .selected')?.dataset.symbol`), 'extra-649');
  assert(await evaluate(`document.querySelectorAll('#tree [data-symbol]').length > 600`));
  const broken=structuredClone(large);broken.nodes.find(n=>n.id==='extra-649').parent='extra-649';
  await importSnapshot(broken);
  assert.equal(await evaluate(`document.querySelector('#tree .selected')?.dataset.symbol`), 'extra-649', 'invalid import replaced the active graph');
  await evaluate(`document.querySelector('#tree [data-symbol="orphan"]').click();document.querySelector('[data-view="map"]').click()`);
  assert(await evaluate(`document.querySelector('#atlas .atlas-node')`),'orphan projected to missing scope');
  await evaluate(`document.querySelector('#tree [data-symbol="hidden-child"]').click();document.querySelector('#locate').click()`);
  assert(await evaluate(`document.querySelector('#atlas .atlas-node')`),'hidden parent projected outside the structural tree');
  await evaluate(`document.querySelector('#demo-button').click()`);
  await waitFor(`document.querySelector('#entries .frontend')`);
  const scenario = JSON.parse(readFileSync(new URL('../examples/scenarios/invalid-quantity.json', import.meta.url)));
  await evaluate(`(() => {const input=document.querySelector('#scenario-import');const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(scenario))}], 'scenario.json', {type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
  await waitFor(`document.querySelector('.journey-finish')`);
  await evaluate(`document.querySelector('#project-toggle').click()`);
  await screenshot('online-desktop');
  await send('Browser.setDownloadBehavior', {behavior:'allow', downloadPath:profile});
  await evaluate(`document.querySelector('#map-export').click()`);
  let htmlPath;
  for (let i=0; i<100; i++) {const filename=readdirSync(profile).find(n=>n.endsWith('.html')); if(filename){htmlPath=join(profile,filename);break;} await delay(100);}
  assert(htmlPath, 'export button did not download HTML');
  let requests = [];
  ws.addEventListener('message', event => {const m=JSON.parse(event.data);if(m.method==='Network.requestWillBeSent') requests.push(m.params.request.url);});
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {offline:true, latency:0, downloadThroughput:0, uploadThroughput:0});
  await send('Page.navigate', {url:'file://' + htmlPath});
  await waitFor(`document.querySelector('.journey-finish')`);
  assert.equal(await evaluate(`document.querySelector('.mode-label').textContent`), '离线地图');
  assert(await evaluate(`document.querySelector('#scenario-title').value === ${JSON.stringify(scenario.title)}`));
  assert(await evaluate(`document.querySelector('#timeline-count').textContent.includes('14')`));
  assert(await evaluate(`document.querySelector('#scan-button').disabled && document.querySelector('#map-export').hidden`));
  assert(await evaluate(`document.fonts.check('14px "Albert Sans"')`));
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await screenshot('offline-desktop');
  await evaluate(`document.querySelector('.journey-decision').click()`);
  await waitFor(`document.querySelector('[data-choice]')`);
  assert(await evaluate(`document.querySelector('#tree .selected')?.textContent.includes('validate_quantity')`));
  await evaluate(`document.querySelector('[data-choice="1"]').click()`);
  await evaluate(`document.querySelector('[data-command="into"]').click()`);
  assert(await evaluate(`document.querySelector('#source').textContent.includes('quantity')`));
  await send('Emulation.setDeviceMetricsOverride', {width:390, height:844, deviceScaleFactor:1, mobile:true});
  await screenshot('offline-mobile');
  assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
  assert(await evaluate(`document.querySelector('#play').getBoundingClientRect().right <= innerWidth`));
  assert.equal(requests.filter(url=>/^https?:/.test(url)).length, 0, 'offline map attempted HTTP requests');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS: online tree/map selection, actual HTML download, offline scenario restore, rewind/choose, syntax/font/theme, mobile, no HTTP requests');
  console.log('screenshots:', shots);
} finally {
  ws?.close(); child.kill();
  await new Promise(r => child.once('exit', r));
  rmSync(profile, {recursive:true, force:true});
}
