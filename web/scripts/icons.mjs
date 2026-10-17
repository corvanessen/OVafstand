// De app-iconen (beginscherm, manifest) opnieuw maken uit favicon.svg:
//   node web/scripts/icons.mjs
// Een vierkant in de achtergrondkleur van de site, met het favicon in het midden. Het favicon
// past ruim binnen de veilige cirkel van een "maskable" icoon (80%), zodat Android het mag bijsnijden.
// Chrome staat op de standaardplek van Windows, of geef het pad in CHROME.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUB = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BG = "#e8eef2"; // als html, body in style.css
const ICONS = { "icon-192.png": 192, "icon-512.png": 512, "apple-touch-icon.png": 180 };

if (!existsSync(CHROME)) {
  console.error(`Chrome niet gevonden op ${CHROME}; geef het pad in CHROME`);
  process.exit(1);
}
const svg = readFileSync(join(PUB, "favicon.svg"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "icons-"));
for (const [name, n] of Object.entries(ICONS)) {
  const html = join(dir, `${n}.html`);
  const d = Math.round(n * 0.7);
  writeFileSync(html, `<!doctype html><html><body style="margin:0;width:${n}px;height:${n}px;background:${BG};
    display:grid;place-items:center">${svg.replace("<svg ", `<svg width="${d}" height="${d}" `)}</body></html>`);
  spawnSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--user-data-dir=${join(dir, "profiel")}`, `--window-size=${n},${n}`,
    `--screenshot=${join(PUB, name)}`, pathToFileURL(html).href], { stdio: "ignore" });
  console.log(name, existsSync(join(PUB, name)) ? "ok" : "MISLUKT");
}
rmSync(dir, { recursive: true, force: true });
