# OV-afstand

Een kaart van Nederland met een heatmap: hoe lang ben je met OV plus fiets onderweg naar elke plek? Het plan en de achtergrond staan in [ONTWIKKELPLAN.md](ONTWIKKELPLAN.md).

## Structuur

```
pipeline/            Python: GTFS → graaf → binaire bestanden voor de browser
  extract_day.py     één werkdag uit de NL GTFS filteren
  stats.py           statistieken (aantallen, intervallen)
  build_graph.py     statische graaf (model A/A+) → data/day_<datum>/graph.npz
  heatmap.py         prototype: one-to-all + PNG-heatmap (matplotlib)
  export_web.py      graph.npz → web/public/data/{graph.bin, meta.json}
web/                 Vite + TypeScript + MapLibre
  src/router.ts      graph.bin laden, Dijkstra, route-uitleg
  src/raster.ts      fietskegels → raster van 250 m, kleuren
  src/grid.ts        Web Mercator-raster dat precies op de kaart past
  src/worker.ts      Web Worker, houdt graaf en laatste resultaat vast
  src/main.ts        kaart, zoekbalk (PDOK), instellingen, tooltip
data/                (niet in versiebeheer) ruwe en tussentijdse data
```

## Data verversen

```bash
curl -o data/raw/gtfs-nl.zip http://gtfs.ovapi.nl/nl/gtfs-nl.zip
python pipeline/extract_day.py 20261110
python pipeline/build_graph.py 20261110
python pipeline/export_web.py 20261110
```

Kies een dinsdag of woensdag buiten de schoolvakanties, binnen de looptijd van de feed (zie `feed_info.txt`).

## Website

```bash
npm --prefix web install
npm --prefix web run dev
```

`npm --prefix web run build` levert een statische site op in `web/dist/`, met de data erin. Die kun je zo op GitHub Pages, Cloudflare Pages of een andere statische host zetten.
