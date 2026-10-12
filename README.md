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
- **Beginwaarden:** de fietstijd naar elke halteplek binnen de fietsgrens vanaf het vertrekpunt. De fietsafstand is hemelsbreed × 1,3, bij de ingestelde snelheid.
- **Wachttijd:** een instapkant kost `min(wachtfactor × interval, 30 min)`.
  - Wachtfactor 0 is model A: alleen rijtijd.
  - Wachtfactor ½ is model A+: gemiddeld een half interval wachten.
  - De factor wordt pas in de browser toegepast, dus wisselen van model kost geen nieuwe data.
- **Stopgrens:** het zoeken stopt zodra de goedkoopste open knoop boven de maximale reistijd van de kleurschaal komt.
- **Resultaat:** per halteplek de reistijd `T(s)`, plus de vorige knoop op de snelste route. Daarmee is later elke route terug te lezen.

Waarom geen dienstregelingsalgoritme zoals CSA of RAPTOR? Een statische graaf geeft één tijdloos antwoord, is klein genoeg voor de browser en klopt goed met de NS-reistijden. Dienstregelingsmodus is gepland voor fase 4, zie het [plan](ONTWIKKELPLAN.md).

### 3. De laatste kilometer: fietskegels op een raster

- Nederland is verdeeld in een raster van **1.147 × 1.380 cellen van ±250 m**. Fietsen gaat met 15 km/u ±250 m per minuut, dus kleinere cellen voegen niets toe.
- Elke bereikte halteplek tekent een "kegel" in het raster ([raster.ts](web/src/raster.ts)): `T(s) + fietstijd`, tot maximaal de fietsgrens.
- Vanaf het vertrekpunt tekent een kegel voor direct fietsen.
- Elke cel houdt het minimum, en onthoudt welke halte dat minimum leverde.
- Daarna krijgt elke cel een kleur: een band per 15 minuten.

### 4. Waarom een nieuwe kaart zo snel klaar is

Na een klik staat de nieuwe heatmap er binnen een paar honderd milliseconden. De statusregel meet het: "netwerk ~50 ms · kaart ~250 ms". Daar zijn deze redenen voor:

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

## Website

```bash
npm --prefix web install
npm --prefix web run dev
```

`npm --prefix web run build` levert een statische site op in `web/dist/`, met de data erin. Die kun je zo op GitHub Pages, Cloudflare Pages of een andere statische host zetten.
