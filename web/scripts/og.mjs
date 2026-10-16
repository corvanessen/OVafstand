// og.png (het deelvoorbeeld, 1200 × 630) opnieuw maken: een screenshot van de site vanaf Utrecht C,
// met in het paneel alleen de titel, het vertrekpunt en de legenda.
//   npm --prefix web run build && npm --prefix web run preview   (in een tweede terminal)
//   node web/scripts/og.mjs [url]                                 (standaard http://localhost:4173/)
// Chrome staat op de standaardplek van Windows, of geef het pad in CHROME.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL0 = process.argv[2] ?? "http://localhost:4173/";
const HASH = "#52.08940,5.11000,Utrecht%20Centraal"; // standaardinstellingen: alleen het vertrekpunt
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/og.png");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const W = 1200, H = 630, PORT = 9334;
const ZOOM_OUT = 2; // zoomstappen terug vanaf de deellink (toets "-")
const WHEEL = 250; // daarna nog een stukje met het scrollwiel (pixels)
// alles in het paneel weg behalve de titel, het vertrekpunt en de legenda; ook de kaartbediening
const CSS = `
  #grip, #fold, #info, .maplibregl-control-container { display: none !important; }
  #panel .body > *:not(#rowA):not(.legend-wrap) { display: none !important; }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "og-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

try {
  for (let i = 0; !ws; i++) {
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
      ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    } catch {
      ws = undefined;
      if (i > 50) throw new Error("Chrome start niet");
      await sleep(200);
    }
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  const js = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s)).result.value;
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.enable", {}, s);
  await send("Page.navigate", { url: URL0 + HASH }, s);

  // klaar: een kaart over de weg (niet meer "fietsraster laden…")
  const t0 = Date.now();
  for (;;) {
    const st = await js(`(document.getElementById("status")?.textContent ?? "") + " | " + (document.getElementById("bikeNote")?.textContent ?? "")`);
    if (/netwerk \d+ ms/.test(st) && !st.includes("laden") && st.includes("over de weg")) {
      console.log(st);
      break;
    }
    if (Date.now() - t0 > 60000) throw new Error(`kaart niet klaar: ${st} (draait de previewserver op ${URL0}?)`);
    await sleep(300);
  }
  await js(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(CSS)}; document.head.append(s); })()`);
  // de deellink zoomt in op het vertrekpunt; met "-" (toetsenbord van MapLibre) uitzoomen tot heel NL
  await js(`document.querySelector(".maplibregl-canvas").focus()`);
  for (let k = 0; k < ZOOM_OUT; k++) {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "-", code: "Minus", windowsVirtualKeyCode: 189 }, s);
    }
    await sleep(600);
  }
  // het laatste stukje met het scrollwiel, rond het midden (het vertrekpunt)
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: W / 2, y: H / 2, deltaX: 0, deltaY: WHEEL }, s);
  await sleep(1000);
  await sleep(4000); // basiskaart en tegels laten laden, en de overgang van de heatmap
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } }, s);
  writeFileSync(OUT, Buffer.from(data, "base64"));
  console.log(`${OUT} (${(Buffer.from(data, "base64").length / 1024).toFixed(0)} kB)`);
} finally {
  ws?.close();
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome kan het profiel nog vasthouden */ }
}
