// De legenda onder de kaart: banden van 15 minuten, of bij "Verschil" de tweekleurige schaal.

import { BAND_MIN, DIFF_A, DIFF_B, DIFF_EDGES, DIFF_SAME, bandColor } from "./raster";
import { diffShown, params } from "./state";
import { $ } from "./ui";

export function renderLegend() {
  const el = $("legend");
  el.innerHTML = "";
  $("legendCaption").hidden = !diffShown();
  if (diffShown()) return renderDiffLegend();
  const n = Math.ceil(params.tMaxMin / BAND_MIN);
  for (let b = 0; b < n; b++) {
    const [r, g, bl] = bandColor(b, n);
    const sw = document.createElement("span");
    sw.style.background = `rgb(${r},${g},${bl})`;
    sw.title = `${b * BAND_MIN}–${(b + 1) * BAND_MIN} min`;
    el.append(sw);
  }
  const labels = $("legendLabels");
  labels.innerHTML = "";
  for (let m = 0; m <= params.tMaxMin; m += params.tMaxMin <= 120 ? 30 : 60) {
    const s = document.createElement("span");
    s.textContent = m === 0 ? "0" : m % 60 === 0 ? `${m / 60} u` : `${m}′`;
    s.style.left = `${(m / params.tMaxMin) * 100}%`;
    labels.append(s);
  }
}

/** verschil A − B: bruin (A sneller) via grijs naar petrol (B sneller), met de grenzen in minuten */
function renderDiffLegend() {
  const edges = DIFF_EDGES;
  const bands = [
    ...DIFF_A.map((c, k) => [c, `A ${edges[k]}${k + 1 < edges.length ? "–" + edges[k + 1] : "+"} min sneller`]).reverse(),
    [DIFF_SAME, `minder dan ${edges[0]} min verschil`],
    ...DIFF_B.map((c, k) => [c, `B ${edges[k]}${k + 1 < edges.length ? "–" + edges[k + 1] : "+"} min sneller`]),
  ];
  for (const [c, title] of bands) {
    const sw = document.createElement("span");
    sw.style.background = c;
    sw.title = title;
    $("legend").append(sw);
  }
  // een getal op elke grens tussen twee banden
  const labels = $("legendLabels");
  labels.innerHTML = "";
  const marks = [...edges.slice().reverse(), ...edges];
  for (const [i, m] of marks.entries()) {
    const s = document.createElement("span");
    s.textContent = i === 0 || i === marks.length - 1 ? `${m}′` : String(m);
    s.style.left = `${((i + 1) / bands.length) * 100}%`;
    s.style.transform = "translateX(-50%)";
    labels.append(s);
  }
}
