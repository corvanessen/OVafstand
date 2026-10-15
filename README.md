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
  osrm_setup.sh      eigen OSRM-fietsserver in WSL (Ubuntu + Docker), localhost:5000; NL plus de strook BE/DE
  build_bike_grid.py fietsraster: wegafstanden per cel naar 16 buren, via OSRM
  export_bike_grid.py  fietsraster → web/public/data/bike.bin.gz
  bike_check.py, bike_grid_test.py, bike_ferry_check.py, grid_bench.mjs   metingen uit fase 3
web/                 Vite + TypeScript + MapLibre
  src/router.ts      graph.bin laden, Dijkstra, route-uitleg
  src/bikegrid.ts    bike.bin.gz laden, Dijkstra over het fietsraster
  src/raster.ts      fietskegels (hemelsbreed) → raster van 250 m, kleuren
  src/grid.ts        Web Mercator-raster dat precies op de kaart past
  src/worker.ts      Web Worker, houdt graaf en laatste resultaat vast
  src/main.ts        kaart, zoekbalk (PDOK), instellingen, label en reisinfo
data/                (niet in versiebeheer) ruwe en tussentijdse data
```

## Hoe het werkt

### 1. Van dienstregeling naar graaf (offline, Python)

De bron is de complete NL-dienstregeling in GTFS-formaat (NDOV Loket / OVapi, ±260 MB gezipt).

- **`extract_day.py`** houdt één representatieve werkdag over: alleen de ritten die op die datum rijden, met tijden omgerekend naar seconden.
- **`build_graph.py`** maakt van die dag een *statische* graaf. De vertrektijden verdwijnen, en elke lijn krijgt een rijtijd en een interval:
  - **Halteplekken:** perrons en haltes van hetzelfde station tellen als één plek (`parent_station`). Dat zijn er ±34.000.
  - **Lijnknopen:** één per route plus richting op elke halteplek. Dat zijn er ±82.500.
  - **Kanten:**

    | Kant | Van → naar | Kosten |
    |---|---|---|
    | Instappen | halteplek → lijnknoop | het interval |
    | Rijden | lijnknoop → volgende lijnknoop | de kortste rijtijd tussen 07 en 19 uur |
    | Uitstappen | lijnknoop → halteplek | 0 |
    | Lopen | halteplek → halteplek binnen 300 m | looptijd |

  - **Interval:** het gecombineerde interval van *alle* voertuigen die naar dezelfde volgende halte rijden. Wie in Utrecht op Amsterdam wacht, neemt de eerste trein die gaat, van welke serie ook.
- **`export_web.py`** zet de graaf om naar [`graph.bin`](web/public/data/graph.bin) (2,9 MB) en `meta.json` (namen en routes, 1 MB):
  - `graph.bin` bestaat uit getypeerde arrays achter elkaar.
  - De kanten staan in CSR-vorm: per knoop een offset in één lange kantenlijst.
  - Kosten zijn hele seconden in `uint16`.

### 2. Zoeken: Dijkstra, one-to-all (browser)

- In de browser draait **Dijkstra** met een binaire heap ([router.ts](web/src/router.ts)). Er wordt niet naar één bestemming gezocht, maar naar *alle* halteplekken tegelijk (*one-to-all*).
- **Beginwaarden:** de fietstijd naar elke halteplek binnen de fietsgrens vanaf het vertrekpunt, over de weg via het fietsraster (zie 3). Met het fietsraster uit, of voor haltes buiten het raster, is het hemelsbreed × 1,3.
- **Wachttijd:** een instapkant kost `min(wachtfactor × interval, 30 min)`.
  - Wachtfactor 0 is model A: alleen rijtijd.
  - Wachtfactor ½ is model A+: gemiddeld een half interval wachten.
  - De factor wordt pas in de browser toegepast, dus wisselen van model kost geen nieuwe data.
- **Stopgrens:** het zoeken stopt zodra de goedkoopste open knoop boven de maximale reistijd van de kleurschaal komt.
- **Resultaat:** per halteplek de reistijd `T(s)`, plus de vorige knoop op de snelste route. Daarmee is later elke route terug te lezen.

Waarom geen dienstregelingsalgoritme zoals CSA of RAPTOR? Een statische graaf geeft één tijdloos antwoord, is klein genoeg voor de browser en klopt goed met de NS-reistijden. Dienstregelingsmodus is gepland voor fase 4, zie het [plan](ONTWIKKELPLAN.md).

### 3. De laatste kilometer: fietsen over een raster

- Nederland is verdeeld in een raster van **1.147 × 1.380 cellen van ±250 m**. Fietsen gaat met 15 km/u ±250 m per minuut, dus kleinere cellen voegen niets toe.
- **Fietsraster** ([bikegrid.ts](web/src/bikegrid.ts)), standaard aan:
  - Offline is met een eigen OSRM-server (fietsprofiel, OpenStreetMap) per cel de wegafstand naar 16 buren berekend. Dat is opgeslagen als 4 bits per kant in `bike.bin.gz` (4,25 MB). Water zonder brug of pont heeft dus geen kant.
  - Het OSM-extract is NL plus België, Noordrijn-Westfalen en Nedersaksen binnen het raster, dus het fietsen loopt over de grens door.
  - Per halteplek is de afstand naar de 3 × 3 cellen eromheen bewaard. Daar begint het fietsen vanaf een halte.
  - In de browser loopt Dijkstra met een bucketwachtrij over het raster: eerst vanaf het vertrekpunt (fietsgrens vanaf vertrekpunt), daarna vanaf alle bereikte haltes tegelijk (fietsgrens vanaf halte).
  - Cellen zonder weg binnen 250 m (weiland, water) krijgen de tijd van de dichtstbijzijnde cel, tot 750 m ver.
  - Meting: in Zeeland en Utrecht wijkt het bij <1% van de paren meer dan 5 min af van OSRM, tegen 11% voor hemelsbreed × 1,3 (zie het [plan](ONTWIKKELPLAN.md), fase 3).
- **Kegels** ([raster.ts](web/src/raster.ts)): met het fietsraster uit, en voor haltes buiten het raster (West-Vlaanderen, verder Duitsland), tekent elke bereikte halteplek een "kegel": `T(s) + fietstijd` met hemelsbreed × 1,3, tot maximaal de fietsgrens.
- Elke cel houdt het minimum, en onthoudt welke halte dat minimum leverde.
- Daarna krijgt elke cel een kleur: een band per 15 minuten.

### 4. Waarom een nieuwe kaart zo snel klaar is

Na een klik staat de nieuwe heatmap er binnen een paar honderd milliseconden. De statusregel meet het: "netwerk ~50–100 ms · kaart ~250–400 ms". Het fietsraster laadt na de graaf (±0,5 s); tot dan rekent de kaart met kegels. Daar zijn deze redenen voor:

- **Het zware werk is al gedaan.**
  - De dienstregeling (miljoenen stoptijden) is vooraf samengevat tot ±117.000 knopen en ±287.000 kanten.
  - De browser rekent dus niet met vertrektijden, maar met een kleine graaf die één keer wordt geladen.
- **Laden zonder parsen.**
  - `graph.bin` wordt in één keer als `ArrayBuffer` opgehaald.
  - De arrays (`Float32Array`, `Uint32Array`, …) zijn rechtstreekse vensters op die buffer. Er hoeft niets omgezet of gekopieerd te worden.
- **Eén zoekactie voor heel Nederland.**
  - Eén Dijkstra-run geeft de reistijd naar alle halteplekken tegelijk.
  - De kantenlijst in CSR-vorm en de getypeerde arrays houden de lus compact en cachevriendelijk.
  - Verouderde heap-items worden simpelweg overgeslagen (*lazy deletion*).
  - Na de stopgrens wordt niets meer bekeken.
- **Het raster is lokaal werk.**
  - Elke halte kleurt alleen de cellen binnen zijn eigen fietsstraal (standaard 5 km, dus ±40 × 40 cellen).
  - Het werk groeit dus met het aantal bereikte haltes, niet met haltes × alle 1,6 miljoen cellen.
  - Haltes die al boven de maximale reistijd zitten, slaan we over.
- **Geen herprojectie.**
  - Het raster ligt in Web Mercator, dezelfde projectie als de kaart ([grid.ts](web/src/grid.ts)).
  - De afbeelding gaat daardoor ongewijzigd als `ImageSource` naar MapLibre, en de GPU tekent hem bij elke zoom en verschuiving.
  - Pannen en zoomen kost dus geen rekenwerk.
- **Rekenen buiten de UI-thread.**
  - Graaf en raster leven in een Web Worker ([worker.ts](web/src/worker.ts)), zodat de kaart soepel blijft.
  - De worker tekent het plaatje op een `OffscreenCanvas` en geeft het als `ImageBitmap` door aan de pagina zonder het te kopiëren (*transfer*).
- **Geen dubbel werk.**
  - Bij schuifjes en slepen wacht een nieuwe berekening 60 ms.
  - Er draait er hooguit één tegelijk. Wijzigingen die tussendoor komen, worden samengevoegd tot één nieuwe berekening.
- **De tooltip is bijna gratis.**
  - Bij hover zoekt de worker niet opnieuw. Hij kijkt welke halte de cel onder de muis leverde.
  - Daarna loopt hij de opgeslagen zoekboom terug naar het vertrekpunt.

## Data verversen

```bash
curl -o data/raw/gtfs-nl.zip http://gtfs.ovapi.nl/nl/gtfs-nl.zip
python pipeline/extract_day.py 20261110
python pipeline/build_graph.py 20261110
python pipeline/export_web.py 20261110
```

Kies een dinsdag of woensdag buiten de schoolvakanties, binnen de looptijd van de feed (zie `feed_info.txt`).

Het fietsraster hangt ook af van de halteplekken. Na een nieuwe GTFS-dag dus ook:

```bash
bash pipeline/osrm_setup.sh grens      # in Ubuntu (WSL); eenmalig (±30 min), of "start" om alleen de server te starten
python pipeline/build_bike_grid.py 20261110
python pipeline/export_bike_grid.py
```

De rijen van het raster staan in `data/bike_grid/grens/` en worden hergebruikt. Daarna zijn alleen de startcellen per halteplek opnieuw nodig (±8 min). Voor nieuwe OSM-data verwijder je `data/bike_grid/grens/`; het hele raster kost dan ±2,5 uur. Loopt OSRM vast (time-outs), dan herstart het script de container zelf.

## Website

```bash
npm --prefix web install
npm --prefix web run dev
```

`npm --prefix web run build` levert een statische site op in `web/dist/`, met de data erin. Die kun je zo op GitHub Pages, Cloudflare Pages of een andere statische host zetten. De workflow in `.github/workflows/pages.yml` publiceert `main` op https://corvanessen.github.io/OVafstand/.

### Deellink

Het vertrekpunt en de instellingen staan in de hash, bijvoorbeeld `#52.08940,5.11000,Utrecht%20Centraal&w=0&t=120`. Alleen afwijkingen van de standaard komen erin:

| Sleutel | Instelling | Standaard |
|---|---|---|
| `w` | wachtfactor: 0,5 = realistisch, 0 = optimistisch | 0.5 |
| `v` | fietssnelheid (km/u) | 15 |
| `b` | fietsen van halte naar bestemming, max (km) | 5 |
| `d` | fietsen vanaf vertrekpunt, max (km) | 15 |
| `t` | kleurschaal tot (min) | 180 |
| `f` | fietsen over de weg (1) of hemelsbreed × 1,3 (0) | 1 |
| `u` | vertrektijd in minuten na middernacht (uurmodel), stappen van 30 | geen: gemiddelde werkdag 07–19 u |
| `p2` | punt B bij vergelijken: `lat,lon,naam` (naam URL-gecodeerd) | geen: één vertrekpunt |
| `m` | bij vergelijken: `diff` = de stand "Verschil" (A − B) | "Voor ons allebei" (de langste van de twee) |

Een waarde die het invoerveld niet kan tonen, wordt genegeerd. Oude links met alleen `#lat,lon,naam` werken nog.

`og.png` (het deelvoorbeeld, 1200 × 630) is een screenshot van de site vanaf Utrecht C. Na een grote wijziging van de kaart maak je hem opnieuw.

### Bezoekers

GoatCounter (https://ovafstand.goatcounter.com) telt bezoeken en een paar gebeurtenissen, zoals `vertrekpunt-zoeken` en `gedeeld-kopie`. Er zijn geen cookies, en de hash met het vertrekpunt gaat niet mee. Op localhost telt het niet. Je eigen bezoeken zet je uit door één keer `#toggle-goatcounter` achter de URL te openen.
