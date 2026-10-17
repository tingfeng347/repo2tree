// ---------------------------------------------------------------- collapsible layout
// sides: left / right aside, source: bottom code panel, sections: panels inside the asides
const LAYOUT_KEY = "codeflow:layout"
const ui = (() => {
  try { return { sides: {}, secs: {}, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") } } catch { return { sides: {}, secs: {} } }
})()
const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(ui)) } catch { /* storage blocked: ui just isn't remembered */ } }

function setSide(side, collapsed) {
  ui.sides[side] = collapsed
  document.body.classList.toggle(`no-${side}`, collapsed)
  const rail = document.querySelector(`.rail[data-toggle="${side}"]`)
  rail.setAttribute("aria-expanded", String(!collapsed))
  rail.querySelector(".railIc").textContent = (side === "left") === collapsed ? "›" : "‹"
  saveLayout()
}

function setSection(sec, collapsed) {
  const el = document.querySelector(`[data-sec="${sec}"]`)
  ui.secs[sec] = collapsed
  el.classList.toggle("collapsed", collapsed)
  const btn = el.querySelector(".secBtn")
  btn.setAttribute("aria-expanded", String(!collapsed))
  btn.textContent = btn.textContent.replace(/^[▾▸]/, collapsed ? "▸" : "▾")
  if (sec === "source") document.body.classList.toggle("no-source", collapsed)
  if (!collapsed && sec === "source") { shownSource.fid = null; renderSourceForPosition() }
  saveLayout()
}

for (const rail of document.querySelectorAll(".rail")) rail.onclick = () => setSide(rail.dataset.toggle, !document.body.classList.contains(`no-${rail.dataset.toggle}`))
for (const el of document.querySelectorAll("[data-sec]")) el.querySelector(".secBtn").onclick = () => setSection(el.dataset.sec, !el.classList.contains("collapsed"))

// focus mode: collapse both sides and the source panel; pressing again restores the previous ui
let beforeFocus = null
function toggleFocus() {
  if (beforeFocus) {
    setSide("left", beforeFocus.left); setSide("right", beforeFocus.right); setSection("source", beforeFocus.source)
    beforeFocus = null
  } else {
    beforeFocus = { left: !!ui.sides.left, right: !!ui.sides.right, source: !!ui.secs.source }
    setSide("left", true); setSide("right", true); setSection("source", true)
  }
  $("#btnFocus").classList.toggle("on", !!beforeFocus)
}
$("#btnFocus").onclick = toggleFocus

document.addEventListener("keydown", (e) => {
  if ((e.target instanceof Element && e.target.matches("input, textarea")) || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === "[") setSide("left", !document.body.classList.contains("no-left"))
  else if (e.key === "]") setSide("right", !document.body.classList.contains("no-right"))
  else if (e.key === "\\") setSection("source", !document.body.classList.contains("no-source"))
  else if (e.key === "f" || e.key === "F") toggleFocus()
  else return
  e.preventDefault()
})

// drag the top edge of the source panel to resize it; height is a share of the centre column
const srcPanel = document.querySelector(".source")
const centre = document.querySelector(".center")
if (ui.srcH) srcPanel.style.setProperty("--srcH", ui.srcH)
document.querySelector(".srcResize").addEventListener("pointerdown", (e) => {
  const handle = e.currentTarget
  handle.setPointerCapture(e.pointerId)
  handle.classList.add("drag")
  const box = centre.getBoundingClientRect()
  const move = (ev) => {
    const pct = Math.min(80, Math.max(12, ((box.bottom - ev.clientY) / box.height) * 100))
    ui.srcH = `${pct.toFixed(1)}%`
    srcPanel.style.setProperty("--srcH", ui.srcH)
  }
  const up = () => { handle.classList.remove("drag"); handle.removeEventListener("pointermove", move); saveLayout() }
  handle.addEventListener("pointermove", move)
  handle.addEventListener("pointerup", up, { once: true })
})

for (const side of ["left", "right"]) setSide(side, !!ui.sides[side])
for (const el of document.querySelectorAll("[data-sec]")) setSection(el.dataset.sec, !!ui.secs[el.dataset.sec])
