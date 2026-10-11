# OV-afstand: ontwikkelplan

Doel: een website met een kaart van Nederland (en de grensstreek). De gebruiker kiest een vertrekpunt door te klikken of een adres in te typen. De kaart toont dan als heatmap hoe lang je met OV plus fiets onderweg bent naar elke plek.

Uitgangspunten:
- We rekenen met ideale verbindingen, dus overstappen kost geen tijd.
- Van en naar haltes fiets je.

---

## 0. Eerst een modelkeuze: wat betekent "ideaal"?

Deze keuze bepaalt het algoritme, dus die maken we eerst.

| Model | Wat telt mee | Graaf | Voordeel | Nadeel |
|---|---|---|---|---|
| **A. Statisch (rijtijd)** | Alleen rijtijd plus fietstijd. Je hoeft nergens op te wachten. | Gewone gewogen graaf zonder tijd | Heel snel, simpel, en voorbewerking werkt goed | Een buslijn die 2× per dag rijdt telt even zwaar als een metro die elke 3 minuten gaat. Op het platteland is het beeld dan te rooskleurig. |
| **A+. Statisch met frequentie-straf** | Als A, plus bij het instappen een gemiddelde wachttijd van ½ × de interval (headway) | Zelfde graaf, met een instapkost per lijn | Nog steeds snel, en veel realistischer | Benadering. Aansluitingen die toevallig goed op elkaar passen zie je niet. |
| **B. Dienstregeling** | Echte vertrektijden, met 0 minuten overstaptijd | Tijdafhankelijk (connections) | Exact voor één vertrekmoment | Het antwoord hangt af van de vertrektijd. Je hebt een tijdschuif of een gemiddelde over een venster nodig. |

**Advies:** begin met **A+**. Bouw **B** later als tweede modus ("vertrek om 08:15"). Beide modellen gebruiken dezelfde datapijplijn.

---

## Stap 1: Algoritme

### 1.1 Opzet: drie lagen

```
[startpunt] --fiets--> [haltes] ==OV-netwerk==> [haltes] --fiets--> [rastercellen]
   (a) toegang            (b) kortste paden over haltes          (c) "laatste kilometer"
```

1. **(a) Toegang:** de fietstijd van het startpunt naar alle haltes binnen een straal R (bijv. 5 km). Dat zijn de beginwaarden in de zoektocht. Fietsen zonder OV is hier al in begrepen, want dat is de rechtstreekse kegel vanaf het startpunt.
2. **(b) Netwerk:** de kortste aankomsttijd T(s) voor elke halte s.
3. **(c) Uitwaaieren:** voor elke rastercel c geldt
   **t(c) = min over haltes s in de buurt van ( T(s) + fietstijd(s, c) )**.

Het belangrijke inzicht: **(b) is klein en (c) is groot.** Nederland heeft ongeveer 50.000 haltepalen. Die clusteren we tot zo'n 25–30k halteplekken (stop areas). Het raster kan miljoenen cellen hebben. Het "lastige dichtbij"-probleem waar je het over had (fietsen, bus, of eerst tram of trein?) lost zich vanzelf op door het minimum in (c) en door de beginwaarden in (a).

### 1.2 Netwerkdeel (b): welk algoritme?

**Model A/A+ (statische graaf):**
- Knopen zijn halteplekken. Een lijn-afhankelijke instap-straf modelleren we met een knoop per (halte, lijnpatroon). Instappen kost dan ½ × de headway en uitstappen kost 0.
- Graafgrootte: ongeveer 150–300k knopen en ongeveer 0,5–1 miljoen kanten.
- **Gewone Dijkstra (binary heap) is hier ruim voldoende.** Een one-to-all-zoekactie duurt naar schatting 20–80 ms in de browser (TypeScript), en minder in WASM.
- Waarom autoroute-technieken hier weinig toevoegen:
  - **A\*, ALT en arc-flags** richten de zoektocht op één doel. Wij willen *alle* doelen, dus daar heb je niets aan.
  - **Contraction Hierarchies (CH)** zijn gemaakt voor wegennetten met miljoenen knopen. Voor ongeveer 200k knopen is de winst klein.
  - **PHAST** (one-to-all op CH) is wél interessant als we het fietsnetwerk exact willen doorrekenen (zie 1.3).
  - **Transit Node Routing (TNR)** is precies jouw intuïtie: "ver weg is het verschil altijd hetzelfde". Je berekent vooraf de afstanden vanaf ongeveer 400 treinstations (de *transit nodes*) naar alle halteplekken. Dat is 400 × 30k ≈ 12 miljoen waarden, ongeveer 24 MB in uint16. Een zoekopdracht is dan *lokale Dijkstra tot de eerste stations + min over (startpunt→station + tabel[station→doel])*. Dit is **alleen nodig als de gewone Dijkstra te traag blijkt**, bijvoorbeeld bij model B met tijdvensters. Houd het achter de hand.

**Model B (dienstregeling, 0 minuten overstaptijd):**
- **Connection Scan Algorithm (CSA)** (Dibbelt e.a. 2013) past hier het best.
  - Alle ritsegmenten (connections) staan in één array, gesorteerd op vertrektijd. Je scant ze één keer: een connection telt als de vertrekhalte al op tijd bereikt is, of als je al in die rit zit.
  - 0 minuten overstaptijd maakt het extra simpel.
  - Het is van nature one-to-all, cache-vriendelijk, en heeft geen heap nodig.
  - NL heeft naar schatting 2–3 miljoen connections per werkdag. Een venster van 3 uur is ongeveer 0,5 miljoen, en dat scan je in ongeveer 10–30 ms.
- **Profielvraag** ("beste reistijd bij vertrek tussen 08:00 en 09:00", of het gemiddelde daarover): gebruik *profile CSA* of **rRAPTOR**. Een eenvoudige benadering: draai CSA voor elke 5 minuten (12 runs) en neem het gemiddelde of de mediaan per cel.
- Fietsen tussen haltes bij een overstap (dus niet alleen aan begin en eind) is het onderwerp van **ULTRA** (Baum e.a. 2019). ULTRA berekent vooraf welke fietsoverstappen ooit nuttig zijn. Voor een eerste versie volstaat iets simpelers: vooraf berekende fietskanten tussen halteplekken tot ongeveer 1,5 km.

### 1.3 Uitwaaieren (c): het eigenlijke rekenwerk

Er zijn drie opties, van grof naar precies:

1. **Hemelsbreed × omrijfactor:** fietstijd = afstand × 1,3 / 15 km/u.
   Dit kan direct op de GPU met de *kegeltruc*. Elke halte tekent een kegel met diepte T(s) + r/v, en de z-buffer houdt per pixel vanzelf het minimum over. Zo heb je een heatmap op schermresolutie in milliseconden.
   - **Nadeel:** water. Het IJsselmeer, Zeeland en de Waddeneilanden geven fouten. Op te lossen met een watermasker en veerboten als OV-kanten.
2. **Vooraf berekende fietstabellen (aanbevolen):** reken per halteplek één keer de echte fietstijd uit over het OSM-fietsnetwerk naar alle rastercellen binnen R = 5 km. Daarvoor gebruiken we OSRM, Valhalla, of een eigen Dijkstra/PHAST op het fietsnetwerk.
   - Bij een raster van 250 m zijn er ongeveer 1.250 cellen per halte. Maal 30k halteplekken is dat ongeveer 38 miljoen waarden. Als uint8 in minuten is dat ongeveer 38 MB, en gecomprimeerd veel minder.
   - Opslaan als tegels: elke kaarttegel bevat de lijst (halte, cel, fietstijd). De browser laadt alleen wat zichtbaar is.
3. **Exacte fiets-one-to-all na de OV-zoekactie:** een multi-source Dijkstra op het hele fietsnetwerk met alle T(s) als beginwaarden, eventueel via PHAST. Dit is het meest precies, maar de browser heeft dan het hele fietsnetwerk nodig (honderden MB). Daarom alleen geschikt voor een server.

**Advies:** voor het MVP optie 1 (snel resultaat zien). Daarna overstappen op optie 2.

### 1.4 Wat we leren van route-apps voor auto's

- Splits het werk in **voorbewerking** (offline, mag uren duren) en **zoekactie** (moet direct antwoord geven). Bij ons gaat de voorbewerking naar de fietstabellen en eventueel de TNR-tabel.
- **Hiërarchie:** veel routes lopen via een klein aantal belangrijke knopen (stations). Dat is de basis van TNR en CH.
- Goal-directed technieken (A\*, ALT) helpen niet bij one-to-all. Daarom schaalt deze opgave anders dan "route van A naar B".

---

## Stap 2: Op welk schaalniveau is dit zinvol?

- **Haltedichtheid:** in steden ligt een halte binnen 300–500 m. Op het platteland zit er soms 2–5 km tussen.
- **Fietssnelheid:** 15 km/u is 250 m per minuut. **Cellen kleiner dan ongeveer 250 m geven dus minder dan 1 minuut verschil.** Dat is kleiner dan de onzekerheid in het model zelf (wachttijden, fietssnelheid, stallen).
- **Rekenen kost per cel bijna niets.** Het OV-deel werkt op haltes, niet op cellen, en het uitwaaieren kan op de GPU. De resolutie wordt dus beperkt door betekenis en datavolume, niet door rekenkracht.

| Niveau | Raster | Cellen NL (land ≈ 35k km²) | Haalbaar? |
|---|---|---|---|
| Landelijk overzicht | 1 km | ~35k | Triviaal |
| **Regio / standaard** | **250 m** | **~560k** | **Ja, sweet spot** |
| Wijk | 100 m | ~3,5 miljoen | Ja met de kegeltruc of tegels. Inhoudelijk weinig extra info. |
| Straat | <50 m | >14 miljoen | Niet zinvol. Schijnprecisie. |

**Conclusie:** een raster van 250 m (dynamisch fijner bij inzoomen, via de GPU) is realistisch voor heel NL.
- De beperkende factor is het **model**, niet de data of de rekentijd.
- Belangrijkste foutbronnen: lage frequenties op het platteland (gebruik dus A+), waterbarrières, en de aanname "0 minuten overstap" bij grote stations (Utrecht Centraal is in werkelijkheid 3–8 minuten lopen tussen perrons).

---

## Stap 3: Data, beschikbaarheid en benaderingen

| Bron | Wat | Gebruik | Oordeel |
|---|---|---|---|
| **NDOV Loket / OVapi GTFS** (`gtfs.ovapi.nl/nl/gtfs-nl.zip`) | Volledige dienstregeling van al het NL OV: NS, regionale treinen, bus, tram, metro, veerboten. Dagelijks bijgewerkt. | **Kernbron** voor model A, A+ en B | Voldoende. Dekt het hele land op halteniveau. |
| **openOV** | Zelfde ecosysteem: realtime (KV6, GTFS-RT) en archieven | Later: vertraging en betrouwbaarheid | Niet nodig voor het MVP |
| **Rijden de Treinen open data** | Historische treindiensten, storingen, stationslijst met coördinaten | Validatie, betrouwbaarheid en stationshiërarchie (bijv. IC-stations als transit nodes) | Nuttige aanvulling |
| **Toegangspunt Mobiliteit (NAP)** | Nationaal toegangspunt, verwijst naar de datasets hierboven plus het **CHB (Centraal Haltebestand)** | Exacte locaties van haltepalen, toegankelijkheid | Gebruiken voor het clusteren van halteplekken |
| ArcGIS Hub-kaart | Nog te verifiëren (waarschijnlijk een halte- of knooppuntenlaag) | Mogelijk een controlelaag | Eerst bekijken |
| busposities.nl | Realtime visualisatie, geen dataset | Inspiratie en controle | n.v.t. |
| **OpenStreetMap** (Geofabrik-extract NL plus grensregio) | Fietsnetwerk, veren, water | Fietstijden (1.3) | Uitstekend in NL |
| **PDOK Locatieserver** | Gratis geocoder voor NL-adressen en -plaatsnamen (BAG) | Zoekbalk | Ideaal, geen API-sleutel nodig |
| Photon / Nominatim | Geocoder buiten NL | Zoekbalk in de grensregio | Rekening houden met fair-use limieten |

**Buiten Nederland (fase 2):**
- België: GTFS van NMBS/SNCB, De Lijn, TEC en MIVB/STIB.
- Duitsland: DELFI / gtfs.de (heel Duitsland, groot). Begin met een uitsnede: NRW en Niedersachsen tot ongeveer 50 km van de grens.
- Internationale treinen (ICE, Eurostar, NS International) staan deels al in de NL GTFS.

**Benaderingen die we bewust maken:**
1. Overstappen kost 0 minuten, eventueel met een optionele vaste straf per overstap.
2. Wachttijd is ½ × de headway in het gekozen tijdvenster (model A+).
3. Fietsen gaat 15 km/u en de fiets kan overal mee of staat overal klaar (stallen kost 0 minuten). Beide als instelling in de UI.
4. Een representatieve werkdag (bijv. de eerstvolgende dinsdag) en een tijdvenster (bijv. 07–19 uur).
5. Lijnen met een interval van meer dan 120 minuten krijgen een maximale wachtstraf of tellen niet mee. Dit is instelbaar.

**Eerste taak in fase 0:** de GTFS downloaden en de aantallen meten (haltes, ritten, connections per dag, headways). Daarmee checken we de schattingen in dit document.

---

## Stap 4: Ontwikkelplan website

### Architectuur

```
Offline pijplijn (Python, later eventueel Rust)          Statische hosting (CDN)            Browser
───────────────────────────────────────────────          ────────────────────────           ──────────────────────────────
GTFS ─┐                                                  graph.bin   (A+ graaf)              MapLibre GL (basiskaart)
CHB  ─┼─> haltes clusteren ─> graaf + headways ───────>  connections.bin (model B)   ───>    Web Worker: Dijkstra / CSA
OSM  ─┴─> fietsrouting ─> fietstabellen per tegel ──>    bike/{z}/{x}/{y}.bin                WebGL-laag: heatmap / isochronen
                                                         stops.bin                           Zoekbalk: PDOK Locatieserver
```

- **Geen eigen backend nodig.** Alle routering draait in de browser (Web Worker). Hosting kan gratis via GitHub Pages of Cloudflare Pages.
- De pijplijn draait wekelijks of dagelijks (GitHub Action) en publiceert nieuwe binaire bestanden.
- Doel voor de downloadgrootte: graaf plus haltes onder 5 MB (gzip). Fietstegels laden we alleen in waar de kaart ze toont.

### Techniekkeuze

- **Pijplijn:** Python met `pandas`/`polars` (GTFS), `osmnx` of een lokale **OSRM**-container met fietsprofiel (fietstabellen), `numpy` (binaire output).
- **Frontend:** Vite + TypeScript + **MapLibre GL JS**. Basiskaart: PDOK BRT-achtergrondkaart (vector) of OpenFreeMap.
- **Routing in de browser:** eerst TypeScript met typed arrays. Rust→WASM alleen als het profileren daar om vraagt.
- **Heatmap:** een eigen WebGL-laag in MapLibre die de kegeltruc rendert, of een raster dat de worker berekent en als `ImageSource` toont. Kleurschaal in stappen van 10 minuten, met isochrone-lijnen.

### Fasering

| Fase | Inhoud | Resultaat |
|---|---|---|
| **0. Verkenning** (1–2 avonden) | GTFS downloaden, statistieken, haltes clusteren, lijnpatronen en headways bepalen. Een Jupyter-notebook met een eerste Dijkstra vanaf Utrecht Centraal. | Gecontroleerde aantallen en een eerste kaartje (matplotlib) |
| **1. Kernmotor** | Graaf voor A+ bouwen, exporteren als binair bestand. Dijkstra in TS, plus een test tegen bekende reizen (vergelijken met 9292 / NS-planner). | `graph.bin` en een routing-module met tests |
| **2. MVP-website** | Kaart, klikken voor het startpunt, PDOK-zoekbalk, heatmap met hemelsbrede fietsafstand (kegeltruc), legenda, tooltip met de reistijd en de route ("fiets 6 min → IC 34 min → fiets 4 min") | Werkende site voor heel NL |
| **3. Realistisch fietsen** | Fietstabellen via OSRM, tegels opslaan, water en veerboten goed meenemen | Correcte randen bij water, nauwkeurig dichtbij |
| **4. Dienstregelingmodus** | CSA met tijdschuif, profiel of gemiddelde over een venster. Wisselen tussen "ideaal" en "dienstregeling". | Tweede modus |
| **5. Grensregio** | België en een uitsnede van Duitsland samenvoegen in de GTFS (stop-ID's laten matchen bij grensstations) | Kaart tot ongeveer 50 km over de grens |
| **6. Extra's** | Twee locaties vergelijken (bijv. "waar is het voor ons allebei < 45 min?"), deelbare URL, instellingen (fietssnelheid, overstapstraf, alleen trein), mobiele weergave | Afwerking |

### Risico's

- **De GTFS-kwaliteit wisselt per vervoerder** (ontbrekende shapes, dubbele haltes). Opvangen met clustering op afstand plus naam.
- **"0 minuten overstap" maakt grote stations onrealistisch goed.** Daarom een optionele straf per overstap in de instellingen.
- **Het OSRM-fietsprofiel rekenen voor 30k halteplekken** duurt naar schatting enkele uren, maar hoeft maar één keer (per OSM-update).
- **De Duitse GTFS is groot** (honderden MB). Daarom de uitsnede al in de pijplijn maken, niet in de browser.

### Resultaten fase 0 (11 okt 2026, feed van 10 okt, dag di 10 nov 2026)

Scripts in `pipeline/`: `extract_day.py` → `stats.py` → `build_graph.py` → `heatmap.py <lat> <lon> <naam> [wait_factor]`. Kaarten staan in `output/`.

**Gemeten in de data:**
- Feed: 259 MB zip. stop_times bevat 20,9 miljoen rijen voor 2 maanden; daarvan 2,2 miljoen op één werkdag.
- 49.663 haltepalen in gebruik, samen te voegen tot 34.264 halteplekken. 665 haltes liggen buiten NL (Keulen, België en Duitsland via De Lijn en Arriva).
- **2,1 miljoen connections per werkdag**: bus 1,90 miljoen, tram 102k, trein 58k, metro 39k, veer 3k. In de spits zijn het ±145k per uur.
- 4.282 route-richtingen tussen 07 en 19 uur. 793 daarvan rijden minder dan 1× per 2 uur, en 653 rijden 1× per 1–2 uur.

**Graaf A+:**
- 116.775 knopen en 286.671 kanten.
- **Dijkstra (scipy) kost 21–37 ms.** Het raster van 1091×1282 cellen (250 m) kost 2–3 s in Python/numpy. In de browser wordt dat GPU-werk.

**Validatie vanuit Utrecht Centraal:**

| Bestemming | Model A (rijtijd) | Model A+ | Echte NS-reistijd (indicatief) |
|---|---|---|---|
| Amsterdam C | 27 | 34 | ±27 |
| Rotterdam C | 37 | 41 | ±37 |
| Groningen | 111 | 123 | ±115 |
| Maastricht | 112 | 122 | ±120 |

**Lessen:**
1. **De wachttijd moet per corridor, niet per route.** Utrecht–Amsterdam wordt door meerdere NS-routes samen bediend. Daarom rekenen we nu het interval over alle voertuigen naar dezelfde volgende halte.
2. **Bij fietsen naar het station telt de afstand zwaar.** Vanaf Ruinen ligt het station van Meppel of Hoogeveen buiten de 5 km fietsgrens. Die grens moet een instelling worden, eventueel met een aparte grotere straal voor treinstations.
3. **De kegels in zee en buiten de grens** zijn verwacht. Fase 3 (water en land) en fase 5 (grensregio) lossen dat op.
4. **De 5-minuten-straf per instap bij het zoeken** voelt realistisch. Een vaste overstapstraf is nog niet nodig.

### Resultaten fase 1+2 (11 okt 2026)

**Export:**
- `pipeline/export_web.py` maakt `graph.bin` (2,9 MB, CSR met uint16-seconden) en `meta.json` (1,0 MB met namen en routes).
- De wachtfactor staat niet vast in het bestand. Instapkanten bewaren het interval, en de browser rekent de wachttijd uit. Zo kun je de modellen A en A+ live wisselen.

**Website** (`web/`, Vite + TypeScript + MapLibre 6, basiskaart OpenFreeMap Positron):
- Dijkstra in een Web Worker kost **25–50 ms**. Het raster (1.146 × 1.378 cellen van 250 m, rechtstreeks in Web Mercator) kost **90–270 ms** op de CPU.
  - De WebGL-kegeltruc is dus (nog) niet nodig.
- **Water:** de heatmap ligt onder de wegen, met daarboven een kopie van de waterlaag uit de basiskaart. Zo lopen de fietskegels niet over zee en meren, zonder dat we zelf een watermasker hoeven te maken.
- **Interactie:**
  - Klik of sleep zet het vertrekpunt.
  - Hover toont de reistijd plus de route ("fiets 45 min naar Hoogeveen → Sprinter → Intercity → fiets 3 min").
  - Op touch: tikken opent een popup met een knop "Vertrek vanaf hier".
  - De vertrekpunt-URL is deelbaar via `#lat,lon,naam`.
- **Zoeken:** PDOK Locatieserver voor adressen, plaatsen en straten, plus lokale treinstations uit de graaf.
- **Instellingen:** model A of A+, fietssnelheid, fietsgrens vanaf het vertrekpunt (geldt ook voor fietsen naar de eerste halte, standaard 15 km), fietsgrens van halte naar bestemming (standaard 5 km), en het bereik van de kleurschaal.

**Bekende beperkingen, de input voor fase 3 en verder:**
- Fietsafstand is hemelsbreed × 1,3, dus bruggen, veerponten en snelwegen tellen niet mee.
- Rond kleine wateren klopt het water-masker, maar de route kan er nog "overheen".
- De JS-bundel is 290 kB gzip (vooral MapLibre). De data is ongeveer 4 MB ongecomprimeerd en wordt bij het laden in één keer opgehaald.
- Er is geen dienstregelingsmodus en geen grensregio.

### Volgende concrete stap

Fase 3, realistisch fietsen:
- Een OSRM-fietsprofiel op een OSM-extract van NL.
- Daarmee per halteplek de fietstijden naar de cellen binnen 5 km berekenen, opgeslagen in tegels.
- Eerst meten hoeveel het hemelsbrede model in de praktijk afwijkt.
