// Collapsible layout: sides, source panel, sections, focus mode, persistence; stage must grow and stepping keep working.
(async () => {
 const sleep = ms => new Promise(r => setTimeout(r, ms))
 const $ = s => document.querySelector(s)
 const box = s => { const r = $(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }
 const out = { stage0: box('.stage'), vb0: $('#map').getAttribute('viewBox') }
 ;[...document.querySelectorAll('#entryList .entry')][0].click()
 $("#btnInto").click(); await sleep(100)
 $('.rail[data-toggle=left]').click(); await sleep(400)
 out.leftCollapsed = box('.left'); out.stageL = box('.stage')
 $('.source .secBtn').click(); await sleep(400)
 out.stageLS = box('.stage'); out.srcCollapsed = box('.source')
 document.querySelector('[data-sec=stack] .secBtn').click(); await sleep(100)
 out.stackCollapsed = box('.stack')
 out.vb1 = $('#map').getAttribute('viewBox')
 // keyboard ] collapses the right side
 document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })); await sleep(400)
 out.stageAll = box('.stage')
 // focus toggle restores?
 $('#btnFocus').click(); await sleep(300); $('#btnFocus').click(); await sleep(400)
 out.afterFocusRestore = [box('.left'), box('.right'), box('.source')]
 out.saved = localStorage.getItem('codeflow:layout')
 out.stepStillWorks = (() => { $('#btnInto').click(); return $('#stack').innerText.split('\n')[0] })()
 return out
})()
