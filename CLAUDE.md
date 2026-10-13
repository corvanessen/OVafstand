# CLAUDE.md

Website met een kaart van NL. De heatmap toont de reistijd met OV plus fiets vanaf een gekozen punt.
- Lees eerst **ONTWIKKELPLAN.md**: modelkeuzes, meetresultaten per fase, en de volgende stap.
- **README.md** beschrijft de structuur en de commando's.
- Communicatie, commentaar en UI-teksten zijn in het **Nederlands**.

## Stand van zaken
Fase 0, 1 en 2 zijn klaar. Fase 3 (realistisch fietsen) loopt:
- de meting van hemelsbreed × 1,3 is klaar;
- een eigen OSRM-server draait in WSL.

De opslagvorm is gekozen: een fietsraster met 16 richtingen (kanten per cel, Dijkstra met een bucketwachtrij in de browser, ±0,5 s voor heel NL). Volgende stap: de grootte omlaag brengen (nu ±5–8 MB) en de uitschieters in Utrecht begrijpen (zie het plan).

**Afspraak:** na elke afgeronde stap de resultaten en de volgende stap bijwerken in ONTWIKKELPLAN.md, en de stand van zaken hier.

## Omgeving (Windows)
- Python 3.13 werkt alleen via **PowerShell** (`python ...`). In Git Bash geeft `python` "Permission denied" (WindowsApps-stub). Beschikbaar: pandas, numpy, scipy, matplotlib. Geen polars of pyarrow, dus tussenbestanden zijn `.pkl` en `.npz`.
- Node 24. Web-commando's: `npm --prefix web run dev | build`, typecheck `npx tsc --noEmit` (in `web/`).
- **Let op bij het bewerken van bestanden via PowerShell** (`Get-Content`/`Set-Content` zonder `-Encoding utf8`): UTF-8 raakt dan dubbel gecodeerd ("…" wordt "â€¦"). Gebruik de Edit-tool of Node.
- **WSL2 (Ubuntu 26.04) met `docker.io`** voor OSRM, zonder sudo. Vanuit PowerShell: `wsl -e bash -lc "..."`, en gebruik `/usr/bin/docker` (de `docker` van Docker Desktop in het PATH werkt niet). De fietsserver staat op `localhost:5000` (`pipeline/osrm_setup.sh start`).
- `.claude/launch.json` bevat de previewservers `web` (dev, :5173) en `web-build` (preview, :4173).

## Datapijplijn (`pipeline/`)
- Volgorde: `extract_day.py <YYYYMMDD>` → `build_graph.py` → `export_web.py`. `stats.py` en `heatmap.py` zijn voor analyse.
- Bron: `http://gtfs.ovapi.nl/nl/gtfs-nl.zip` (±260 MB) naar `data/raw/`. `data/` staat niet in git.
- Kies een dinsdag of woensdag buiten de schoolvakanties, binnen `feed_start_date`..`feed_end_date` (feed_info.txt).
- `web/public/data/{graph.bin,meta.json}` staat **wel** in git. Opnieuw genereren na een data-update.

## Model (zie het plan voor het waarom)
- **Knopen:** halteplekken (`parent_station`, anders de `stop_id`) plus lijnknopen (route+richting @ halteplek).
- **Kanten:** instappen (kost = min(wachtfactor × interval, 30 min)), uitstappen (0), rijden (minimale rijtijd in 07–19 u), lopen (≤ 300 m).
- **Interval = het gecombineerde interval van alle voertuigen naar dezelfde volgende halte (corridor), niet per route.** Per route was veel te pessimistisch: Utrecht→Amsterdam kwam uit op 44 in plaats van 34 min.
- De wachtfactor staat niet in `graph.bin`. Instapkanten (kind=1) bewaren het interval, de browser rekent de wachttijd uit.
- **Fietsgrenzen:**
  - `directMaxKm`: vanaf het vertrekpunt, voor direct fietsen én voor fietsen naar de eerste halte.
  - `bikeMaxKm`: van de laatste halte naar de bestemming.
  - Fietsafstand = hemelsbreed × 1,3 bij 15 km/u.
- **Validatie:** model A (alleen rijtijd) vanaf Utrecht C geeft Amsterdam C 27, Rotterdam C 37, Groningen 111 min. Dat komt overeen met NS.

## Web (`web/`)
- **MapLibre GL 6:**
  - Het pakket heeft alleen named exports (`import { Map } from "maplibre-gl"`).
  - De eigen worker van MapLibre moet expliciet via `setWorkerUrl(url)` met `import url from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"` en `worker.format: "es"` in vite.config. Anders: "Worker failed to load".
- **TypeScript 7, Vite 8.**
- Het raster staat in **Web Mercator** (`grid.ts`), zodat het als ImageSource zonder vervorming op de kaart past. `ROW_SCALE` zet per rij mercator-meters om naar echte meters.
- **Water-masker:** de heatmap-laag ligt vóór de eerste `transportation`-laag, met daarboven een kopie van de `water`-filllagen uit de OpenFreeMap Positron-stijl.
- **Interactie:**
  - Met de muis: hover toont reistijd en route, klikken zet het vertrekpunt.
  - Met touch (`pointerType === "touch"`): tikken opent een popup met "Vertrek vanaf hier". Dit is nog niet getest op een echt toestel.
- Zoeken gaat via de PDOK Locatieserver (`/search/v3_1/free`) plus de treinstations uit de graaf.

## Verifiëren
- **Pipeline:** `python pipeline/heatmap.py 52.0894 5.11 "Utrecht Centraal" 0`. De reistijden moeten overeenkomen met de validatie hierboven.
- **Web:** typecheck, daarna de dev-server. Controleer:
  - de heatmap verschijnt, en de statusregel toont "netwerk ~50 ms · kaart ~250 ms";
  - de tooltip toont een route;
  - zoeken naar "Ruinen" werkt;
  - geen fouten in de console.
