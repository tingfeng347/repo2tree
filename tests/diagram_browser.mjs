// Real-browser integration, isolated Chrome profile. Requires an already running repo2tree server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:7331';
const shots = resolve(process.argv[3] || '.impeccable/review/diagrams');
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

  await send('Page.navigate',{url});
  await waitFor(`document.querySelector('#entries .frontend')`);
  const clickView=async view=>evaluate(`document.querySelector('[data-view="${view}"]').click()`);
  await clickView('sequence');
  assert(await evaluate(`document.querySelector('.diagram-empty')?.textContent.includes('先记录')`));
  await clickView('overview');
  assert(await evaluate(`document.querySelectorAll('.diagram-group').length === 2`));
  assert(await evaluate(`document.querySelectorAll('.diagram-connection.dashed').length > 0`));
  await evaluate(`document.querySelector('.diagram-node').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  assert(await evaluate(`document.querySelector('#tree .selected')?.dataset.symbol===document.querySelector('.diagram-node.selected')?.dataset.diagramSymbol`));
  assert(await evaluate(`!document.querySelector('#panel-symbol').hidden && document.querySelector('#panel-symbol').textContent.includes('条出向证据')`));
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:profile});
  await evaluate(`document.querySelector('[data-diagram-export]').click()`);
  await waitFor(`document.querySelector('#diagram-svg')`);
  for(let i=0;i<100&&!readdirSync(profile).some(n=>n.endsWith('.svg'));i++)await delay(100);
  const svgPath=join(profile,readdirSync(profile).find(n=>n.endsWith('.svg'))||'missing.svg');
  const exported=readFileSync(svgPath,'utf8');
  assert(exported.includes('<svg'));assert(exported.includes('<style'));assert(!exported.includes('NaN'));
  assert(await evaluate(`!new DOMParser().parseFromString(${JSON.stringify(exported)},'image/svg+xml').querySelector('parsererror')`));
  await screenshot('overview-light');
  await evaluate(`document.querySelector('#search').value='validate_quantity';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('#entries [data-entry]').click()`);
  await clickView('flow');
  assert(await evaluate(`document.querySelectorAll('.diagram-node').length > 4`));
  assert(await evaluate(`document.querySelector('.diagram-node[data-tone="branch"]')`));
  await evaluate(`document.querySelector('[data-diagram-zoom]').click();document.querySelector('.diagram-node[data-diagram-op]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  assert(await evaluate(`document.querySelector('#panel-symbol').textContent.includes('validate_quantity')`));
  await evaluate(`(()=>{const node=document.querySelector('.diagram-node[data-diagram-op]');node.focus();node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  assert(await evaluate(`document.activeElement?.hasAttribute('data-diagram-symbol')`),'diagram redraw lost keyboard focus');
  assert(await evaluate(`document.querySelector('#source-path').textContent.includes('backend/app.py')`));
  await evaluate(`document.querySelector('[data-diagram-scale="1.25"]').click()`);
  assert(await evaluate(`parseInt(document.querySelector('#diagram-zoom').textContent)>65`));
  await evaluate(`document.querySelector('[data-diagram-zoom]').click()`);
  await screenshot('flow-light');
  const scenario=JSON.parse(readFileSync(new URL('../examples/scenarios/order-success.json',import.meta.url)));
  await evaluate(`(()=>{const input=document.querySelector('#scenario-import'),data=new DataTransfer();data.items.add(new File([${JSON.stringify(JSON.stringify(scenario))}], 'success.json',{type:'application/json'}));input.files=data.files;input.dispatchEvent(new Event('change'));})()`);
  await waitFor(`document.querySelector('.journey-finish')`);
  await clickView('sequence');
  assert(await evaluate(`document.querySelectorAll('.diagram-lifeline').length > 3`));
  assert(await evaluate(`document.querySelector('.diagram-count').textContent.includes('页')`));
  await screenshot('sequence-light');
  await evaluate(`(()=>{const button=document.querySelector('[data-diagram-page="1"]');button.focus();button.click();})()`);
  assert(await evaluate(`document.querySelector('.diagram-count').textContent.startsWith('2/')`));
  assert(await evaluate(`document.activeElement?.classList.contains('diagram-scroll')`),'last-page focus did not fall back to canvas');
  await evaluate(`document.querySelector('[data-diagram-page="-1"]').click()`);
  await evaluate(`document.querySelector('.diagram-message').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  assert(await evaluate(`document.querySelector('#status').textContent!=='已结束'`));
  await evaluate(`document.querySelector('#project-toggle').click();document.querySelector('#map-export').click()`);
  let htmlPath;for(let i=0;i<100;i++){const name=readdirSync(profile).find(n=>n.endsWith('.html'));if(name){htmlPath=join(profile,name);break;}await delay(100);}
  assert(htmlPath,'HTML download failed');
  const requests=[];ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))requests.push(m.params.request.url);});
  await send('Network.enable');await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await send('Page.navigate',{url:'file://'+htmlPath});
  await waitFor(`document.querySelector('#diagram-svg')`);
  assert(await evaluate(`document.querySelector('[data-view="sequence"]').getAttribute('aria-selected')==='true'`));
  await clickView('overview');await evaluate(`document.querySelector('#theme-toggle').click()`);
  await delay(250);await screenshot('overview-dark');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await clickView('flow');
  assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
  assert(await evaluate(`document.querySelector('.diagram-scroll').clientWidth>200`));
  assert(await evaluate(`(()=>{const canvas=document.querySelector('.diagram-scroll').getBoundingClientRect(),entry=document.querySelector('.diagram-node[data-diagram-node]')?.getBoundingClientRect();return [...document.querySelectorAll('.diagram-node')].some(n=>{const r=n.getBoundingClientRect();return r.left>=canvas.left&&r.right<=canvas.right&&r.top>=canvas.top&&r.bottom<=canvas.bottom;});})()`),'mobile flow has no complete visible node');
  await screenshot('flow-mobile');
  await clickView('sequence');
  await screenshot('sequence-mobile');
  assert.equal(requests.length,0,JSON.stringify(requests));assert.equal(exceptions.length,0,JSON.stringify(exceptions));
  console.log('PASS: three views, empty state, candidate links, tree/source/inspector, zoom, valid SVG export, sequence paging/seek, offline view restoration, 390px, no HTTP');
  console.log('screenshots:',shots);
} finally {
  ws?.close();child.kill();await new Promise(r=>child.once('exit',r));rmSync(profile,{recursive:true,force:true});
}
