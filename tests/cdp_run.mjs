// Headless-Chrome smoke runner: node cdp_run.mjs <html> <script.js> [shot.png]
// Chrome path: $CHROME, else common install locations.
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const [html, scriptPath, shot] = process.argv.slice(2)
const port = 9333 + Math.floor(Math.random() * 500)
const prof = mkdtempSync(join(tmpdir(), "codeflow-chrome-"))
const chrome = [process.env.CHROME, "/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p))
if (!chrome) { console.error("no Chrome found; set CHROME"); process.exit(2) }
const ch = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1600,1000", "--no-first-run", "about:blank"], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break } } catch {} await sleep(200) }
await new Promise((r) => ws.addEventListener("open", r))
let id = 0; const pend = new Map(); const logs = []
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } else if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(d.params.exceptionDetails).slice(0, 600)); else if (d.method === "Runtime.consoleAPICalled") logs.push(d.params.type + " " + d.params.args.map((a) => a.value ?? a.description).join(" ")) })
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send("Runtime.enable"); await send("Page.enable")
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send("Page.navigate", { url: "file://" + html.replace(/^(?!\/)/, process.cwd() + "/") }); await sleep(1500)
const r = await send("Runtime.evaluate", { expression: readFileSync(scriptPath, "utf8"), awaitPromise: true, returnByValue: true })
console.log("RESULT", JSON.stringify(r.result?.result?.value, null, 1), r.result?.exceptionDetails?.exception?.description ?? "")
if (shot) { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(shot, Buffer.from(s.result.data, "base64")) }
console.log(logs.join("\n"))
ch.kill(); rmSync(prof, { recursive: true, force: true }); process.exit(r.result?.exceptionDetails ? 1 : 0)
