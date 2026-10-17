// Drives tests/fixture output: cross-stack stepping, step-out class/module, exception unwinding, breakpoints.
(async () => {
 const sleep = ms => new Promise(r => setTimeout(r, ms))
 const $ = s => document.querySelector(s)
 const card = () => $('#stepCard').innerText.replace(/\n/g,' | ')
 const stack = () => $('#stack').innerText.replace(/\n/g,' | ')
 const pick = (txt) => { const l=[...document.querySelectorAll('#choices .choice')].find(c=>c.innerText.includes(txt)); l.querySelector('input').click() }
 const entry = (txt) => [...document.querySelectorAll('#entryList .entry')].find(b=>b.textContent.includes(txt)).click()
 $('#optAnim').click()
 const out = {}
 // 1. frontend loadItem -> HTTP -> read_item -> Store.get, then step out of class
 const q=$('#entrySearch'); q.value='loadItem'; q.dispatchEvent(new Event('input')); entry('loadItem')
 for (let k=0;k<3;k++){ $('#btnInto').click(); await sleep(50) }
 out.a_stack = stack()
 $('#btnInto').click(); await sleep(50); $('#btnInto').click(); await sleep(50)
 out.b_stack = stack()
 $('#btnOutClass').click(); await sleep(500)
 out.c_afterOutClass = stack() + ' || ' + card()
 $('#btnOutModule').click(); await sleep(500)
 out.d_afterOutModule = stack() + ' || ' + card()
 // 2. exception path: Store.get raises KeyError -> caught -> HTTPException uncaught
 q.value=''; q.dispatchEvent(new Event('input')); entry('GET/api/items')
 $('#btnInto').click(); await sleep(50)  // try
 $('#btnInto').click(); await sleep(50)  // enter Store.get
 pick('if key not in self.data')
 $('#btnContinue').click(); await sleep(800)
 out.e_exc = card()
 out.e_trace = $('#tab-trace').innerText.split('\n')
 // 3. function breakpoint on validate_char, continue from POST
 const vc = [...document.querySelectorAll('#tree .tnode')]
 entry('POST/api/items')
  for (let k=0;k<2;k++){ $('#btnInto').click(); await sleep(50) }
  $('#btnInto').click(); await sleep(50)
  $('#btnInto').click(); await sleep(50)
  out.f0 = stack()
  $('[data-tab=trace]').click(); await sleep(50)
  ;[...document.querySelectorAll('#tab-trace .ev')].find(e=>e.textContent.includes('→ validate_char')).click(); await sleep(100)
  $('#infoBp').click(); await sleep(50)
  entry('POST/api/items'); await sleep(50)
  ;[...document.querySelectorAll('#src .row')].find(r=>r.querySelector('.gut').textContent==='41').querySelector('.gut').click()
  $('#btnContinue').click(); await sleep(400)
  out.f_bpFn = stack() + ' || ' + card()
  $('#btnContinue').click(); await sleep(400)
  out.f2 = stack() + ' || ' + card()
  $('#btnContinue').click(); await sleep(400)
  out.g_bpLine = stack() + ' || ' + card()
  $('#btnContinue').click(); await sleep(400)
  out.h_end = card()
  $('[data-tab=bps]').click(); await sleep(50)
  out.i_bps = $('#tab-bps').innerText.replace(/\n/g,' | ')
  $('[data-tab=cov]').click(); await sleep(50)
  out.j_cov = $('#tab-cov').innerText.split('\n')[0]
 return out
})()
