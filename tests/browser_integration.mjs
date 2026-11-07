// Real-browser integration, isolated Chrome profile. Requires an already running repo2tree server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:7331';
const shots = process.argv[3] ? resolve(process.argv[3]) : null;
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
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) { if (await evaluate(`document.querySelectorAll('[data-entry]').length > 0`)) break; await delay(100); }
  assert(await evaluate(`document.querySelector('#project-name').textContent === 'shop'`));
  assert(await evaluate(`document.querySelector('.journey-welcome') && document.querySelector('#play').disabled`));
  await evaluate(`document.querySelector('#entries .frontend').closest('button').click()`);
  const controls = await evaluate(`(() => {
    const $ = s => document.querySelector(s), width = () => $('.stage').getBoundingClientRect().width;
    const before = width(); $('#left-toggle').click(); $('#right-toggle').click(); const after = width();
    const collapsed = after > before + 350;
    $('#left-restore').click(); $('#right-restore').click();
    if ($('.source-panel').getBoundingClientRect().height > 0) $('#source-toggle').click();
    const sourceHidden = $('.source-panel').getBoundingClientRect().height === 0;
    $('#focus-toggle').click(); const focus = width() > before + 350; $('#focus-toggle').click();
    $('[data-view="calls"]').click(); const callNodes = $('#atlas').querySelectorAll('[data-symbol]').length;
    $('[data-view="flow"]').click(); const flowVisible = !$('#diagram-view').hidden && $('#diagram-view').textContent.includes('onClick') && $('#atlas').getBoundingClientRect().height === 0;
    $('[data-view="map"]').click();
    return { collapsed, sourceHidden, focus, callNodes, flowVisible };
  })()`);
  assert(controls.collapsed); assert(controls.sourceHidden); assert(controls.focus); assert(controls.callNodes > 0); assert(controls.flowVisible);
  console.log('layout and semantic views', controls);
  const path = await evaluate(`(async () => {
    const $ = s => document.querySelector(s); const wait = () => new Promise(r => setTimeout(r, 0));
    const visited = new Set(), loops = new Map();
    for (let i = 0; i < 750; i++) {
      visited.add($('#session-entry').textContent); const type = $('.event-kind')?.textContent;
      if (type === '演示结束') return { ended: true, timeline: $('#timeline-count').textContent, source: $('#source-path').textContent, text: $('#timeline').textContent };
      const choices = [...document.querySelectorAll('[data-choice]')];
      if (choices.length) {
        let choice = 0;
        if (choices[0].textContent.includes('为真') || choices[0].textContent.includes('if (')) choice = 1;
        if (choices[0].textContent.includes('进入第')) {
          const key = $('.step-text').textContent; const count = loops.get(key) || 0; loops.set(key,count+1); choice = count >= 2 ? 1 : 0;
        }
        choices[choice]?.click();
      } else $('[data-command="into"]').click();
      await wait();
    }
    return { ended: false, step: $('#current-step').textContent };
  })()`);
  assert(path.ended, JSON.stringify(path)); console.log('frontend → API → nested functions', path);
  assert(await evaluate(`(() => {document.querySelector('[data-view=journey]').click();return Boolean(document.querySelector('.journey-finish [data-save-current]'))})()`));
  const saved = await evaluate(`(() => { const $=s=>document.querySelector(s);$('#scenario-title').value='浏览器验证';$('#scenario-save').click();const saved=$('[data-scenario]')?.textContent; $('[data-command="restart"]').click();$('[data-scenario]').click();return {saved,status:$('#status').textContent}; })()`);
  assert.equal(saved.saved, '浏览器验证'); assert.equal(saved.status, '已结束');
  const depthRestore=await evaluate(`(() => { const d=document.querySelector('#max-depth');d.value='32';d.dispatchEvent(new Event('change'));const reset=document.querySelector('#timeline-count').textContent.includes('第 1 个事件');document.querySelector('[data-scenario]').click();return {reset,restored:d.value,status:document.querySelector('#status').textContent}; })()`);
  assert(depthRestore.reset);assert.equal(depthRestore.restored,'16');assert.equal(depthRestore.status,'已结束');
  const breakpoint = await evaluate(`(() => {
    const $ = s => document.querySelector(s); const find = name => { $('#search').value=name;$('#search').dispatchEvent(new Event('input'));return [...document.querySelectorAll('[data-entry]')].find(b=>b.textContent.includes(name)); };
    find('reserve').click(); $('#breakpoint-selected').click(); find('create_order').click();
    for(let i=0;i<250;i++) {
      if($('#status').textContent==='命中断点') return {hit:true,source:$('#source-path').textContent};
      const choices=[...document.querySelectorAll('[data-choice]')];
      if(choices.length) {let selected=choices[0].textContent.includes('为真')?1:0;choices[selected]?.click();}
      else $('[data-command="over"]').click();
    }
    return {hit:false,step:$('#current-step').textContent};
  })()`);
  assert(breakpoint.hit, JSON.stringify(breakpoint)); console.log('step-over honors nested breakpoints', breakpoint);
  const lineBP = await evaluate(`(() => { const b=document.querySelector('[data-line-bp="8"]');b.click();return b.getAttribute('aria-label'); })()`);
  assert(lineBP.includes('设置')); // The captured node is replaced; verify the new node separately.
  assert(await evaluate(`document.querySelector('[data-line-bp="8"]').classList.contains('has-bp')`));
  const state = await (await fetch(url + '/api/project')).json();
  const forbidden = await fetch(url + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ path: state.project.path }) });
  assert.equal(forbidden.status, 403);
  const failure = await fetch(url + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/this/path/does/not/exist' }) });
  assert.equal(failure.status, 400); assert.deepEqual((await (await fetch(url + '/api/project')).json()).snapshot, state.snapshot);
  const scanned=await fetch(url+'/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:state.project.path,index:false})});
  assert.equal(scanned.status,200);const scannedGraph=await scanned.json();assert.equal(scannedGraph.stats.functions,15);assert.equal(scannedGraph.stats.structuredFunctions,15);
  await evaluate(`(() => { document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input'));[...document.querySelectorAll('[data-entry]')].find(b=>b.querySelector('small').textContent==='UI').click(); document.querySelector('[data-view="map"]').click();document.querySelector('[data-panel="step"]').click();return true; })()`);
  await evaluate(`(() => {
    for(let i=0;i<30;i++) {
      if(document.querySelector('.event-kind')?.textContent==='函数调用' && document.querySelector('.step-text')?.textContent.includes('submitOrder')) break;
      const choice=document.querySelector('[data-choice="0"]');
      if(choice) choice.click();else document.querySelector('[data-command="into"]').click();
    }
    document.querySelector('[data-panel="coverage"]').click();
    if(document.querySelector('#panel-coverage').textContent.includes('NaN')) throw new Error('invalid coverage');
    document.querySelector('[data-panel="step"]').click();
    return true;
  })()`);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await delay(200);
    const desktop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(shots, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`document.querySelector('[data-view="flow"]').click()`); await delay(100);
  const mobile = await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth, main:document.querySelector('main').getBoundingClientRect().width, viewport:innerWidth})`);
  assert.equal(mobile.overflow, false, JSON.stringify(mobile));
  assert(await evaluate(`document.querySelector('#play').getBoundingClientRect().right <= innerWidth`));
  assert(await evaluate(`document.querySelector('#atlas').getBoundingClientRect().height === 0 && document.querySelector('#diagram-view').getBoundingClientRect().height > 100`));
  if (shots) { const screen = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(shots, 'mobile.png'), Buffer.from(screen.data, 'base64')); }
  await evaluate(`document.querySelector('#right-restore').click()`);
  assert(await evaluate(`document.querySelector('.right-pane .pane-content').getBoundingClientRect().width > 300`));
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('HTTP origin checks, scan errors, mobile layout, scenario restore: passed');
} finally {
  ws?.close(); child.kill();
  await new Promise(r => child.once('exit', r));
  rmSync(profile, { recursive: true, force: true });
}
