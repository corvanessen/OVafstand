# CLAUDE.md

Website met een kaart van NL. De heatmap toont de reistijd met OV plus fiets vanaf een gekozen punt.
- Lees eerst **ONTWIKKELPLAN.md**: modelkeuzes, meetresultaten per fase, en de volgende stap.
- **README.md** beschrijft de structuur en de commando's.
- Communicatie, commentaar en UI-teksten zijn in het **Nederlands**.

## Stand van zaken
Fase 0, 1, 2 en 3 (realistisch fietsen) zijn klaar. Een eigen OSRM-server draait in WSL.

De opslagvorm is gekozen: een fietsraster met 16 richtingen, 4 bits per kant, en een halte die start in 3 × 3 cellen. Dijkstra met een bucketwachtrij in de browser kost ±0,5 s voor heel NL. In proefregio's wijkt het bij <1% van de paren meer dan 5 min af van OSRM, tegen 11% voor hemelsbreed × 1,3. Het raster is gebouwd op een OSM-extract van NL plus de strook BE/DE binnen de rasterbox (`build_bike_grid.py` → `export_bike_grid.py` → `web/public/data/bike.bin.gz`, 4,25 MB). Het is ingebouwd in de web-app (`bikegrid.ts`, standaard aan). Van de 578 ponten in OSM doen er 525 mee. De rest ontbreekt door OSM zelf (laagwaterafsluiting, losse aanlegplaats). Fase 6.1 (snelle winst) is klaar op branch `fase6`: instellingen in de deellink, delen, Open Graph en favicon, uitleg, mijn locatie en voorbeeldchips. Fase 6.2 (bezoekers meten met GoatCounter, `ovafstand.goatcounter.com`) is klaar. Fase 6.3 (smartphone: bottom sheet, reisinfo in de sheet) is klaar in de emulatie, maar nog niet getest op een echt toestel. Fase 6.4 deel 1 (uurmodel, tijdschuif) staat in main. Op branch `fase6-nacht` komen daar bij: de nachtlijnen, 48 halve uren, vloeiend afspelen (frames vooruit, overgang) en het diagram "Binnen 1 uur bereikbaar". Op branch `fase6-vergelijk` (vanaf `fase6-nacht`) staat 6.5 deel 1: twee vertrekpunten vergelijken, stand "Voor ons allebei" (max van A en B), ook met de tijdschuif. Daar staat ook 6.7 stap 1: het paneel inklappen, en de reisinfo vast in het paneel na een klik. 6.5 deel 2, de stand "Verschil" (A − B, tweekleurig), en 6.7 stap 2 (fiets bij vertrek/aankomst, anders lopen) en stap 3 (kaart naar het dichtstbijzijnde IC-station) zijn daar ook klaar. Volgende stap: 6.7 stap 4 (zaterdag en zondag); zie het plan.

**Afspraak:** na elke afgeronde stap de resultaten en de volgende stap bijwerken in ONTWIKKELPLAN.md, en de stand van zaken hier.

## Omgeving (Windows)
- Python 3.13 werkt alleen via **PowerShell** (`python ...`). In Git Bash geeft `python` "Permission denied" (WindowsApps-stub). Beschikbaar: pandas, numpy, scipy, matplotlib. Geen polars of pyarrow, dus tussenbestanden zijn `.pkl` en `.npz`.
- Node 24. Web-commando's: `npm --prefix web run dev | build`, typecheck `npx tsc --noEmit` (in `web/`).
- **Let op bij het bewerken van bestanden via PowerShell** (`Get-Content`/`Set-Content` zonder `-Encoding utf8`): UTF-8 raakt dan dubbel gecodeerd ("…" wordt "â€¦"). Gebruik de Edit-tool of Node.
- **WSL2 (Ubuntu 26.04) met `docker.io`** voor OSRM, zonder sudo. Vanuit PowerShell: `wsl -e bash -lc "..."`, en gebruik `/usr/bin/docker` (de `docker` van Docker Desktop in het PATH werkt niet). De fietsserver staat op `localhost:5000` (`pipeline/osrm_setup.sh start`; die kiest het grensextract `~/osrm/grens.osrm`). `osmium` draait in de Docker-image `osmium-tool`. Downloaden in WSL met `curl`, want `wget` lost Geofabrik niet op.
- `.claude/launch.json` bevat de previewservers `web` (dev, :5173) en `web-build` (preview, :4173).

## Datapijplijn (`pipeline/`)
- Volgorde: `extract_day.py <YYYYMMDD>` → `build_graph.py` → `export_web.py`. `stats.py` en `heatmap.py` zijn voor analyse.
- Fietsraster (fase 3): `osrm_setup.sh grens` (in WSL) → `build_bike_grid.py` (±2,5 uur, te onderbreken, rijen in `data/bike_grid/grens/`; herstart OSRM zelf als die vastloopt) → `export_bike_grid.py`. Na een nieuwe GTFS-dag zijn de startcellen per halteplek opnieuw nodig. `bike_check.py`, `bike_grid_test.py`, `bike_ferry_check.py` en `grid_bench.mjs` zijn metingen.
- Bron: `http://gtfs.ovapi.nl/nl/gtfs-nl.zip` (±260 MB) naar `data/raw/`. `data/` staat niet in git.
- Kies een dinsdag of woensdag buiten de schoolvakanties, binnen `feed_start_date`..`feed_end_date` (feed_info.txt).
- `web/public/data/{graph.bin,meta.json,hours.bin.gz}` staat **wel** in git. Opnieuw genereren na een data-update.

## Model (zie het plan voor het waarom)
- **Knopen:** halteplekken (`parent_station`, anders de `stop_id`) plus lijnknopen (route+richting @ halteplek).
- **Kanten:** instappen (kost = min(wachtfactor × interval, 30 min)), uitstappen (0), rijden (minimale rijtijd in 07–19 u), lopen (≤ 300 m).
- **Interval = het gecombineerde interval van alle voertuigen naar dezelfde volgende halte (corridor), niet per route.** Per route was veel te pessimistisch: Utrecht→Amsterdam kwam uit op 44 in plaats van 34 min.
- De wachtfactor staat niet in `graph.bin`. Instapkanten (kind=1) bewaren het interval, de browser rekent de wachttijd uit.
- **Uurmodel (fase 6.4):** `hours.bin.gz` geeft per instapkant per half uur (`meta.hours.bins` = 48) de gemiddelde wachttijd in minuten (255 = geen vertrek), gemiddeld over een uur rond het tijdvak. Zonder dat venster flikkert de kaart door lijnen die één keer per uur rijden. Die is berekend uit alle vertrekken van de dag in de drukste corridor. Met `departMin` gebruikt `search` die wachttijd bij kloktijd = vertrektijd + label. De wachtfactor telt dan niet.
- **Nachtlijnen:** lijnknopen en rijkanten die alleen buiten 07–19 u bestaan, staan ook in de graaf. Hun instapkant heeft kost 65535 en is dicht in het dagmodel. Hun rijkanten zijn kind=2 en tellen alleen in het uurmodel. Het dagmodel geeft daardoor precies dezelfde uitkomst als zonder nachtlijnen.
- **Fietsgrenzen:**
  - `directMaxKm`: vanaf het vertrekpunt, voor direct fietsen én voor fietsen naar de eerste halte.
  - `bikeMaxKm`: van de laatste halte naar de bestemming.
  - Fietsafstand = hemelsbreed × 1,3 bij 15 km/u.
  - **Fiets bij vertrek / bij aankomst** (`bikeStart`, standaard aan; `bikeEnd`, standaard **uit**): zonder fiets loop je dat stuk, 5 km/u tot 2 km (`WALK_KMH`, `WALK_MAX_KM`), over hetzelfde fietsraster. `legs(p)` in `router.ts` geeft snelheid en grens per stuk; gebruik die, niet `bikeKmh`/`bikeMaxKm` direct.
- **Validatie:** model A (alleen rijtijd) vanaf Utrecht C geeft Amsterdam C 27, Rotterdam C 37, Groningen 111 min. Dat komt overeen met NS.

## Web (`web/`)
- **MapLibre GL 6:**
  - Het pakket heeft alleen named exports (`import { Map } from "maplibre-gl"`).
  - De eigen worker van MapLibre moet expliciet via `setWorkerUrl(url)` met `import url from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"` en `worker.format: "es"` in vite.config. Anders: "Worker failed to load".
- **TypeScript 7, Vite 8.**
- Het raster staat in **Web Mercator** (`grid.ts`), zodat het als ImageSource zonder vervorming op de kaart past. `ROW_SCALE` zet per rij mercator-meters om naar echte meters.
- **Fietsraster (`bikegrid.ts`):**
  - Laadt `bike.bin.gz` na de graaf; tot dan, of als het ontbreekt, rekent de kaart met kegels (`raster.ts`).
  - Twee Dijkstra-runs met een bucketwachtrij: vanaf het vertrekpunt (directMaxKm; dat geeft ook de begintijden voor `search`), dan vanaf de bereikte haltes (bikeMaxKm).
  - Haltes zonder startcellen (buiten de rasterbox: West-Vlaanderen, verder Duitsland) tekenen nog kegels.
  - De schakelaar `realBike` zet het uit.
- **Worker-opdrachten** (`main.ts`): een gewone kaart ("view", één tegelijk), een frame tijdens afspelen (twee vooruit) of `profile` (diagram, op de achtergrond). De worker bewaart de laatste vier resultaten per id. De tooltip vraagt het getoonde resultaat op (`resultId`).
- **Heatmap:** twee `ImageSource`-lagen (`heat0` en `heat1`), die tijdens afspelen in 400 ms in elkaar overvloeien.
- **Testen zonder browser-tool:** Chrome headless via CDP (`--remote-debugging-port`) werkt voor de status, de tooltip, zoeken en screenshots. De rekenkern los in Node: bundel met `npx rolldown <test.ts> --platform node` (in `web/`).
- **Water-masker:** de heatmap-laag ligt vóór de eerste `transportation`-laag, met daarboven een kopie van de `water`-filllagen uit de OpenFreeMap Positron-stijl.
- **Interactie:**
  - Hover (muis) toont een klein label met de minuten.
  - Klikken of tikken zet de reisinfo vast in `#info`, bovenaan het paneel of de sheet, met een knop "Vertrek vanaf hier". Die rekent mee met elke nieuwe kaart; sluiten met × of Esc. Het vertrekpunt verplaats je met die knop, door de punt te slepen, of met zoeken.
  - Op de desktop is het paneel in te klappen (`.folded`, onthouden in localStorage).
  - **Smal scherm (< 640 px):** het paneel is een bottom sheet (`data-sheet`: collapsed, half of full), met een greep om te tikken of te vegen. Testen als telefoon: CDP met `Emulation.setTouchEmulationEnabled` en `Input.dispatchTouchEvent`.
- Zoeken gaat via de PDOK Locatieserver (`/search/v3_1/free`) plus de treinstations uit de graaf.
- **Vergelijken (6.5):** punt B (`pointB`, deellink `&p2=lat,lon,naam`). De worker rekent A en B apart (`cachedRun`, de laatste vier runs) en kleurt per cel de langste van de twee ("Voor ons allebei") of het verschil A − B ("Verschil", `compareMode`, `colorizeDiff` in `raster.ts`; wisselen rekent niets opnieuw). `editing` bepaalt welk punt klikken, zoeken en de voorbeelden verplaatsen; klik op rij A of B om te wisselen.
- **IC-kaart (6.7 stap 3):** `source` = `"point"` of `"ic"` (deellink `&k=ic`). Bij `"ic"` start de zoektocht met tijd 0 op alle IC-stations (`icStations` in `worker.ts`: overdag een trein "Intercity…", niet `IFF:NS_INT`; 95 stuks). Het laatste stuk volgt dan `bikeStart`/`directMaxKm`, want het ligt aan de kant van de plek zelf. De reisinfo draait de route om (`icHtml`). Zoeken toont daar de reisinfo in plaats van het vertrekpunt te verplaatsen.
- **Deellink:** `#lat,lon,naam&w=…&v=…&b=…&d=…&t=…&f=…&u=…&s=…&a=…&k=ic&p2=…&m=diff`, met alleen afwijkingen van `DEFAULTS` in `main.ts`. Ongeldige waarden worden genegeerd (zie README).
- `og:image` wijst naar de volledige Pages-URL (`corvanessen.github.io/OVafstand/og.png`).
- **Bezoekers:** GoatCounter via `track("naam")` in `main.ts`. Stuur alleen namen van gebeurtenissen mee, nooit coördinaten of adressen. Op localhost telt het niet.

## Verifiëren
- **Pipeline:** `python pipeline/heatmap.py 52.0894 5.11 "Utrecht Centraal" 0`. De reistijden moeten overeenkomen met de validatie hierboven.
- **Web:** typecheck, daarna de dev-server. Controleer:
  - de heatmap verschijnt, en de statusregel toont "netwerk ~50–100 ms · kaart ~250–400 ms", en de voetregel "fiets bij vertrek, lopen bij aankomst · over de weg (OpenStreetMap)"; met "Fiets bij aankomst" aan geeft Utrecht C "28.960 haltes binnen 3 uur";
  - de tooltip toont een route;
  - zoeken naar "Ruinen" werkt;
  - geen fouten in de console.
