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
| **6. Gebruikers en bereik** | Bezoekers meten, deellink met instellingen, Open Graph, uitleg, mijn locatie, bottom sheet op mobiel, dag-animatie (uurmodel), twee vertrekpunten vergelijken. Later: overstapstraf, alleen trein. Zie "Fase 6 in detail". | Begrijpelijk en deelbaar voor bezoekers zonder voorkennis |

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
- De wachttijd ½ × interval geldt alleen voor een perfect regelmatige dienst. Bij onregelmatige intervallen is de verwachte wachttijd (H/2)·(1 + σ²/H²), dus langer. Mogelijke uitbreiding: σ per corridor uitrekenen in de pipeline.
- Rijtijden en intervallen komen uit 07–19 u op één werkdag. Voor de avond, de nacht en het weekend is de kaart dus te gunstig.

### Volgende concrete stap

Fase 3, realistisch fietsen:
- ~~Eerst meten hoeveel het hemelsbrede model in de praktijk afwijkt.~~ Klaar, zie stap 1 hieronder.
- ~~Een OSRM-fietsprofiel op een OSM-extract van NL.~~ Klaar, zie stap 2.
- ~~In één regio uitproberen hoe compact de fietstijden kunnen.~~ Eerste proef klaar (stap 3): een fietsraster met Dijkstra in de browser wint van tabellen per halte.
- ~~Het fietsraster verbeteren en de rekentijd meten.~~ Klaar (stap 4): 16 richtingen, ±0,5 s voor heel NL.
- ~~De grootte omlaag brengen en de uitschieters in Utrecht begrijpen.~~ Klaar (stap 5): start in 3 × 3 cellen, 4 bits, ±3–4 MB, fout > 5 min bij <1%.
- ~~Het fietsraster voor heel NL bouwen.~~ Klaar (stap 6): `bike.bin.gz`, 2,25 MB.
- ~~Het fietsraster inbouwen in de web-app.~~ Klaar (stap 7).
- ~~Het grensextract (strook BE en DE) en fietspontjes controleren.~~ Klaar (stap 8). Daarmee is fase 3 af.
- ~~Fase 6.1, snelle winst.~~ Klaar, zie "Resultaten fase 6.1".
- ~~Bezoekers meten (6.2).~~ Klaar, zie "Resultaten fase 6.2".
- ~~De smartphone (6.3).~~ Klaar in de emulatie, zie "Resultaten fase 6.3". Testen op een echt toestel moet de gebruiker nog doen.
- **Nu:** de animatie van een werkdag (6.4), te beginnen met het uurmodel in de pijplijn. Fase 5 (GTFS van BE en DE) kan ook; het fietsraster is er al klaar voor.

### Resultaten fase 3, stap 1: hoe goed klopt hemelsbreed × 1,3? (13 okt 2026)

`pipeline/bike_check.py` vergelijkt het model met echte fietsroutes van de publieke OSRM-fietsserver van FOSSGIS (`routing.openstreetmap.de`).
- **Steekproef:** 218 van de geplande 300 halteplekken. Per halte 40 bestemmingen binnen 5 km en 10 tussen 5 en 15 km, samen 10.900 paren.
- **Server:** die gaf na ongeveer 200 haltes HTTP 429. Het script stopt dan met ophalen en analyseert de cache. `--offline` analyseert alleen de cache.
- **Weggelaten:** 17% van de bestemmingen ligt meer dan 250 m van een fietsbare weg (water, weiland).

| Afstand hemelsbreed | Paren | Omrijfactor p10 / p50 / p90 | Fout model p50 / p90 / p98 (min) |
|---|---|---|---|
| 0,3–1 km | 329 | 1,05 / 1,34 / 2,09 | +0,3 / +3,0 / +6,6 |
| 1–2 km | 897 | 1,14 / 1,37 / 2,02 | +0,6 / +4,9 / +12,2 |
| 2–3 km | 1.450 | 1,15 / 1,35 / 1,85 | +0,8 / +5,9 / +14,1 |
| 3–5 km | 4.652 | 1,16 / 1,33 / 1,71 | +0,8 / +6,9 / +17,9 |
| 5–10 km | 653 | 1,15 / 1,29 / 1,57 | 0,0 / +8,5 / +23,7 |
| 10–15 km | 1.043 | 1,17 / 1,27 / 1,48 | −1,1 / +9,5 / +28,2 |

Fout = fietstijd over de echte route min de modeltijd, beide bij 15 km/u. Positief betekent dat het model te gunstig is.

**Conclusies:**
- **De mediaan klopt.** Binnen 5 km is de mediane factor 1,34. De best passende vaste factor is 1,30, precies wat het model nu gebruikt.
- **Stad of platteland maakt weinig uit.** De mediane factor is 1,33 in de stad en 1,36 op het platteland.
- **OSRM rekent met 14,4 km/u** (mediaan), dicht bij de 15 km/u van het model.
- **De fout zit in de staart.** Binnen 5 km wijkt het model bij 13,9% van de paren meer dan 5 min af en bij 4,7% meer dan 10 min, bijna altijd te gunstig.
- **De ergste gevallen zijn water zonder brug:**
  - Terschelling: +318 min;
  - Elahuizen aan de Fluessen: +70 min;
  - Wemeldinge aan het kanaal en de Oosterschelde: +59 min;
  - Maasvlakte: +46 min;
  - Hardinxveld aan de Merwede: +44 min.
- **Gevolg voor fase 3.** Een andere vaste factor levert niets op. De winst zit alleen bij barrières. Dat rechtvaardigt echte fietstijden per halte via OSRM, maar het meeste gebied klopt nu al binnen 5 min.

### Resultaten fase 3, stap 2: eigen OSRM-server (13 okt 2026)

- **Omgeving.** WSL2 met Ubuntu 26.04 en `docker.io`. `osrm-backend` zit niet in apt. `C:\Users\corva\.wslconfig` geeft WSL 10 GB geheugen en 16 GB swap.
- **Opzet.** `pipeline/osrm_setup.sh` (in Ubuntu) downloadt `netherlands-latest.osm.pbf` (1,4 GB) naar `~/osrm`. Daarna draait OSRM v5.27.1 met `bicycle.lua` en MLD, en start de container `osrm-fiets` op `localhost:5000`. Na een herstart is alleen `bash pipeline/osrm_setup.sh start` nodig.
- **Verwerking.** Ongeveer 6 minuten, met een piek van 2,6 GB geheugen. De graaf heeft 10,0 miljoen knopen en 38,8 miljoen kanten.
- **Controle.** `bike_check.py --local` op dezelfde 300 haltes en 15.000 paren duurde ongeveer een minuut.
  - De routeafstand lokaal/publiek is in de mediaan 1,00 (p2–p98: 0,84–1,10).
  - Mediane omrijfactor 1,34; de best passende factor is 1,32.
  - Het model wijkt bij 12,9% meer dan 5 min af en bij 4,5% meer dan 10 min.
  - De ergste omwegen zijn dezelfde routes als bij de publieke server.
  - OSRM rekent lokaal met 13,7 km/u, publiek met 14,2 km/u. Dat maakt niet uit, want we rekenen met onze eigen snelheid.
- **Grens.** Lokaal valt 29% van de bestemmingen af (meer dan 250 m van een weg), publiek 16%. Het verschil zit bij Belgische haltes uit de GTFS (Maasmechelen, Hasselt, Beerse) en bij bestemmingen over de grens, want het extract bevat alleen NL. Voor fase 3 is dus een extract met een strook BE en DE nodig.

### Resultaten fase 3, stap 3: opslagvorm, eerste proef (13 okt 2026)

`pipeline/bike_grid_test.py <regio>` vergelijkt twee opslagvormen met de eigen OSRM-server als waarheid. Per regio 56–60 haltes met de cellen binnen 5 km. Beide regio's samen hebben ±73.000 paren.
- **A. Tabellen per halte.** Voor elke halte de fietstijd naar elke cel, of alleen de correcties.
- **B. Fietsraster.** Per cel de wegafstand naar 4 buren (O, N, NO, NW; de andere 4 zijn dezelfde kanten terug), als uint8-omrijfactor. De browser doet dan Dijkstra over de cellen, met de haltes als bron.

Zeeland (261 × 242 cellen, 50% met een weg binnen 250 m) en Utrecht (137 × 134 cellen, 77%). Fout = schatting − OSRM, in minuten bij 15 km/u.

| | Zeeland p2 / p50 / p98 | Zeeland \|fout\| > 3 / > 5 min | Utrecht p2 / p50 / p98 | Utrecht \|fout\| > 3 / > 5 min |
|---|---|---|---|---|
| Model hemelsbreed × 1,3 | −15,5 / −0,8 / +2,2 | 20,8% / 11,1% | −11,5 / −0,7 / +2,1 | 20,9% / 10,9% |
| B. fietsraster, ruw | −1,5 / +2,5 / +7,3 | – / 13,3% | −0,1 / +3,3 / +11,8 | – / 27,2% |
| B. × vaste factor (0,844 / 0,804) | −4,9 / 0,0 / +3,5 | 6,9% / 2,4% | −4,0 / 0,0 / +6,3 | 12,2% / 4,4% |

**Grootte voor heel NL:**
- B kost ±2,5–3,8 MB (zlib), geschat vanuit de verhouding land/water in de regio.
- A met alleen correcties boven 5 min kost ±6–8 MB, boven 3 min ±12–14 MB, boven 2 min ±19–22 MB.

**Conclusies:**
- **B wint.** B is kleiner, en het werkt ook voor het vertrekpunt (`directMaxKm`). A kan dat niet, want het vertrekpunt ligt overal. B vangt de barrières: het model is tot 15 min te gunstig, B maar enkele minuten.
- **B is systematisch te lang.** Ruw is B 18–24% te lang. Dat komt door het zigzaggen tussen de gesnapte punten van naburige cellen: die liggen soms op verschillende straten. Ook de achtrichtingsmetriek telt mee, die gemiddeld ±5% te lang is.
- **Eén vaste factor helpt, maar verschilt per gebied:** 0,84 in Zeeland en 0,80 in Utrecht. Een beter raster heeft de factor liefst niet nodig.

### Resultaten fase 3, stap 4: 16 richtingen en rekentijd (13 okt 2026)

`bike_grid_test.py <regio> <n> <variant>` met drie varianten:
- `8`: zoals in stap 3;
- `16`: daarbij de paardensprongen (2,1);
- `16L`: daarbij ook lange rechte kanten (2,0), (0,2), (2,2) en (−2,2), samen 24 richtingen.

Fout = raster − OSRM, zonder correctiefactor:

| Variant | Zeeland p2 / p50 / p98 (min) | Zeeland > 5 min | Utrecht p2 / p50 / p98 (min) | Utrecht > 5 min | Raster/OSRM (mediaan) | NL zlib |
|---|---|---|---|---|---|---|
| Model × 1,3 | −15,5 / −0,8 / +2,2 | 11,1% | −11,5 / −0,7 / +2,1 | 10,9% | – | 0 |
| 8 | −1,5 / +2,5 / +7,3 | 13,3% | −0,1 / +3,3 / +11,8 | 27,2% | 1,19–1,24 | 2,5–3,8 MB |
| **16** | −2,4 / +1,3 / +4,4 | **2,3%** | −1,0 / +1,8 / +9,6 | **8,6%** | 1,10–1,14 | 5,1–7,7 MB |
| 16L | −2,5 / +1,0 / +3,8 | 1,8% | −1,4 / +1,4 / +8,9 | 6,0% | 1,08–1,10 | 7,6–11,5 MB |

**Rekentijd** (`pipeline/grid_bench.mjs`, Node/V8, synthetisch raster van heel NL met 59% land, 16 richtingen):
- Met een binaire heap: 1,5–2,0 s als vrijwel heel NL bereikt wordt (±0,8 mln cellen).
- Met een bucketwachtrij (Dial, 10 s) en de kanten per cel naast elkaar: **±0,5 s** voor 0,9–1,0 mln cellen, ±0,15 s voor ±0,35 mln cellen.
- 1 byte per kant in plaats van 2 gaf geen winst.
- Fietsen vanaf het vertrekpunt (15 km) kost ±5 ms.

**Conclusies:**
- **16 richtingen is de beste keuze.** Zonder correctiefactor wijkt het raster in Zeeland bij 2,3% meer dan 5 min af, tegen 11,1% voor het model. 16L wint daar weinig op, voor 50% meer data.
- **Utrecht blijft lastiger.** Het raster wijkt daar bij 8,6% meer dan 5 min af (p98 +9,6 min). Het raster is dan te lang, waarschijnlijk door cellen die op een weg aan de andere kant van een barrière snappen, zoals een spoor of gracht. Dit is nog niet onderzocht.
- **De grootte valt tegen.** Met 16 richtingen is het ±5–8 MB zlib voor heel NL. De doelstelling is een paar MB. Mogelijke winst: 4 bits per kant, kanten weglaten die even lang zijn als de route via twee kortere kanten, of tegels per regio die pas laden als ze nodig zijn.
- **De rekentijd is ±0,5 s voor heel NL**, tegen 90–270 ms nu. Dat is acceptabel voor een klik, maar niet tijdens slepen. Een mogelijke oplossing: tijdens het slepen de snelle kegels tonen, en na het loslaten het fietsraster.

### Resultaten fase 3, stap 5: startcellen, 4 bits en snoeien (13 okt 2026)

`bike_grid_test.py <regio> 60 16 <R> [--prune] [--4bit]` slaat nu per paar halte, cel en fouten op in `data/bike_grid/`, voor nader onderzoek.

**Uitschieters in Utrecht.** Die zaten bij een paar haltes: bij Houten Meidoornkade en De Biltsche Hoek was 98% van de paren meer dan 5 min fout. Het raster startte alleen in de cel van de halte. Ligt het gesnapte midden van die cel achter een spoor of water, dan begint elke route met een omweg. De oplossing: de halte start in de 3 × 3 cellen eromheen (R = 1), elk met de echte fietsafstand halte → celknoop uit OSRM. Dat kost 9 bytes per halteplek, ±0,3 MB voor NL.

**Fout in de 8-bitsversie.** Omrijfactoren boven 8,94 werden afgekapt in plaats van weggelaten. Een kant zonder brug werd zo een te korte sluiproute; daar kwam de p2 van −3 min vandaan. De 4-bitsversie laat te grote factoren weg.

**4 bits per kant.** 15 niveaus van de omrijfactor (1,00 / 1,04 / 1,08 / 1,13 / 1,19 / 1,26 / 1,35 / 1,46 / 1,6 / 1,8 / 2,05 / 2,4 / 2,9 / 3,6 / 4,5) plus "geen kant". Factoren boven ±5 worden geen kant, nooit afgerond naar beneden.

**Snoeien.** Een kant valt weg als een pad over twee andere kanten even kort of korter is. Kortste paden blijven exact gelijk. Dat haalt 17–19% van de kanten weg, maar scheelt in grootte maar ±7%.

Variant 16, fout = raster − OSRM, zonder correctiefactor:

| | Zeeland p2 / p50 / p98 (min) | Zeeland > 5 min | Utrecht p2 / p50 / p98 (min) | Utrecht > 5 min | NL zlib |
|---|---|---|---|---|---|
| Model × 1,3 | −15,5 / −0,8 / +2,2 | 11,1% | −11,5 / −0,7 / +2,1 | 10,9% | 0 |
| 8 bits, start 1 cel | −2,4 / +1,3 / +4,4 | 2,3% | −1,0 / +1,8 / +9,6 | 8,6% | 5,1–7,7 MB |
| 8 bits, start 3 × 3 | −3,1 / +0,5 / +3,3 | 1,9% | −1,9 / +1,0 / +4,0 | 1,1% | 5,1–7,7 MB |
| **4 bits, start 3 × 3, gesnoeid** | **−1,1 / +0,5 / +3,5** | **0,7%** | **−1,0 / +1,0 / +4,1** | **0,8%** | **2,8–4,3 MB** |

Het raster is nu in de mediaan 4–7% te lang, zonder correctiefactor. De NL-grootte is geschat vanuit de regio's; de echte waarde volgt pas uit een raster voor heel NL.

### Resultaten fase 3, stap 6: fietsraster voor heel NL (14 okt 2026)

- **`pipeline/build_bike_grid.py`** bouwt het raster met de eigen OSRM-server. Het is te onderbreken: elke rij blokken komt in een eigen bestand in `data/bike_grid/nl/` en wordt bij een nieuwe start overgeslagen. Het resultaat is `data/bike_grid/nl_raw.npz`, met de ruwe afstanden in meters.
  - Het raster is 1147 × 1380 cellen, gelijk aan `grid.ts`, in 173 rijen van 144 blokken. Netto ±80 min rekenwerk, ±30 s per rij door het midden van het land.
  - Vannacht stopte de run halverwege, waarschijnlijk door de slaapstand. OSRM bleef daarna doorrekenen aan de afgebroken verzoeken (840% CPU). Een herstart van de container (`docker restart osrm-fiets`) en een nieuwe start van het script loste dat op. De container staat nu op `--restart unless-stopped`.
  - 499.066 cellen (31,5%) hebben een fietsbare weg binnen 250 m. Er zijn 12,6 mln kanten.
  - Daarbij komen de startcellen: voor 34.264 halteplekken de afstand naar de knopen van de 3 × 3 cellen eromheen, in 261 s.
- **`pipeline/export_bike_grid.py`** schrijft `web/public/data/bike.bin.gz`. Het formaat staat in het script.
  - **2,25 MB gzip** (7,4 MB ruw: kanten 6,3, snap 0,8, startcellen 0,31 MB).
  - Snoeien haalt 20% van de kanten weg: van 3,33 naar 2,67 mln.
- **Halteplekken zonder startcel:** 6.286, allemaal in België (Antwerpen, Hasselt, Zonhoven en andere), 0,3–30 km buiten het NL-extract. Dat lost het grensextract op.

### Resultaten fase 3, stap 7: fietsraster in de web-app (14 okt 2026)

- **`web/src/bikegrid.ts`:**
  - **Laden.** Laadt `bike.bin.gz` en pakt het zelf uit met `DecompressionStream` als de server geen `Content-Encoding` zet.
  - **Opbouw bij het laden.** De kanten komen in CSR-vorm, beide richtingen, met de lengte in echte meters (`Uint16`). De startcellen per halteplek worden omgezet naar knopen. Het laden kost ±0,4–0,7 s, na de graaf. Tot dan rekent de kaart met kegels.
  - **Stap 1, vanaf het vertrekpunt.** Dijkstra met een bucketwachtrij (10 s) over het raster, met de fietsgrens vanaf het vertrekpunt. Het vertrekpunt start in de 5 × 5 cellen eromheen, hemelsbreed × 1,3 naar het celmidden. Daaruit volgen de begintijden van de haltes, via hun startcellen. De OV-zoektocht (`search`) krijgt die begintijden nu van buiten.
  - **Stap 2, vanaf de haltes.** Dijkstra vanaf alle bereikte haltes tegelijk, met de fietsgrens vanaf de halte. Elke cel krijgt de snelste van beide tijden, plus de snapafstand.
  - **Terugval.** Haltes zonder startcellen (België) tekenen nog een hemelsbrede kegel. Dat geldt ook voor het vertrekpunt buiten het raster.
  - **Aanvullen.** Cellen zonder weg binnen 250 m krijgen via een afstandstransformatie in twee passes de tijd van de dichtstbijzijnde bereikte cel, tot 750 m. Knopen worden nooit aangevuld, anders ontstaan alsnog sluiproutes over water.
- **UI:**
  - een schakelaar "Fietsen: over de weg (OpenStreetMap)", standaard aan;
  - de voetregel toont welk model actief is.
- **Rekentijd vanaf Utrecht C**, 3 uur, met wachttijd, in Node: netwerk 70 ms, kaart 387 ms, gelijk aan de kegels (55 / 387 ms).
  - De eerste versie was 740 ms. De winst kwam van de CSR-kanten, de vooraf omgezette startcellen en een aanvulstap zonder closures.
  - In headless Chrome (software-rendering, trager) is het raster 340–450 ms, de kegels 260–450 ms.
- **Reistijden** (raster / kegels, min): Amsterdam C 38 / 34, Rotterdam C 44 / 42, Groningen 129 / 124, Houten 22 / 20. Het raster is wat langer, door echte routes en de ±5% systematische fout uit stap 5.
- **Gecontroleerd in Chrome:**
  - de heatmap verschijnt;
  - de tooltip toont de route;
  - zoeken naar "Ruinen" werkt;
  - de schakelaar wisselt het model;
  - er zijn geen consolefouten (alleen het ontbrekende favicon, dat al zo was).
- **Visueel bij Goes:** de kegels lopen over de Oosterschelde en de Westerschelde door; het raster volgt het wegennet.

**Bekende beperkingen:**
- **Over de grens.** Cellen over de grens zijn alleen gekleurd vanuit Belgische haltes (kegels). Vanaf Nederlandse haltes stopt het fietsen aan de grens, tot het grensextract er is.
- **Fietsgrens.** De fietsgrens geldt per label: de eerste halte die een cel bereikt, bepaalt de gefietste afstand. Dat is een benadering.
- **Veerponten.** Kleine veerponten zonder GTFS-dienst ontbreken waarschijnlijk in het fietsraster. Dat is nog niet gecontroleerd.

**Volgende stap:**
1. ~~Het fietsraster voor heel NL bouwen en de echte grootte meten.~~ Klaar (stap 6): 2,25 MB gzip.
2. ~~Het inbouwen in de web-app.~~ Klaar (stap 7).
3. ~~Het grensextract met een strook BE en DE, en controleren of fietspontjes meedoen.~~ Klaar (stap 8).

Het plan was om tijdens het slepen de kegels te tonen en na het loslaten het fietsraster. Dat is niet nodig: het raster is even snel als de kegels.

### Resultaten fase 3, stap 8: grensextract en veerponten (14 okt 2026)

**Grensextract:**
- `osrm_setup.sh grens` haalt de Geofabrik-extracten van NL, België, Noordrijn-Westfalen en Nedersaksen, knipt ze met `osmium` op de rasterbox (3,2–7,4 O, 50,6–53,7 N) en voegt ze samen tot `grens.osm.pbf`. `osmium` draait in een eigen image (`osmium-tool`, Debian), omdat er geen sudo is.
  - Downloaden met `curl`: `wget` kon in WSL de naam van Geofabrik niet oplossen (alleen IPv6).
  - Verwerken met OSRM kost ±25 min. `start` kiest het grensextract als dat er is.
- **Het raster opnieuw gebouwd** in `data/bike_grid/grens/` → `grens_raw.npz`. De oude NL-versie (`nl/`, `nl_raw.npz`) blijft om te vergelijken.
  - Netto ±2,3 uur, tegen ±80 min voor NL alleen: de zuidelijke rijen zijn nu overal land (±1,3 min per rij).
  - Halverwege liep OSRM weer vast (±820% CPU, time-outs), net als in stap 6, maar bij een andere rij. Het lag dus niet aan één blok. `build_bike_grid.py` herstart de container nu zelf bij een time-out (120 s) en wacht tot OSRM weer antwoordt.
- **Resultaat:**
  - 979.738 knopen (61,9% van de cellen), tegen 499.066.
  - Na snoeien 5,43 mln kanten.
  - Halteplekken zonder startcel: 358, tegen 6.286. Daarvan liggen er 356 buiten de rasterbox (West-Vlaanderen ten westen van 3,2° O, verre Duitse ICE-haltes).
- **`bike.bin.gz` is nu 4,25 MB** (was 2,25). Een strook van 15 km rond de halteplekken (de maximale fietsgrens vanaf een halte) zou maar 11% van de knopen schelen, want De Lijn dekt heel Vlaanderen. Daarom het volle raster; fase 5 heeft het toch nodig.
- **Rekentijd** (Node): laden 380 ms (was 210). De kaart kost vanaf Utrecht C 233 ms, vanaf Venlo 103 ms, vanaf Maastricht 68 ms. Dat is gelijk aan het NL-raster, want de fietsgrenzen bepalen hoeveel cellen bereikt worden, niet de grootte van het raster.
- **Over de grens** (raster, min):

| Van → naar | NL-raster | Grensraster | Kegels |
|---|---|---|---|
| Venlo → Straelen (DE) | – | 51 | 57 |
| Venlo → Lanaken (BE) | 105 | 105 | 104 |
| Maastricht C → Lanaken (BE) | 26 | 26 | 26 |
| Utrecht C → Emmerich (DE) | 107 | 108 | 106 |

  Vanaf Utrecht C kleurt het grensraster iets minder cellen (562k tegen 572k), omdat de Belgische haltes nu over de weg fietsen in plaats van met een kegel.
- **In Chrome** (headless, vanaf Venlo): de heatmap loopt langs de wegen door naar Straelen, Viersen, Brüggen en Belgisch Limburg. De tooltip bij Straelen geeft "Fiets 59 min". De statusregel toont netwerk 46–115 ms en kaart 330–560 ms (software-rendering). De console geeft geen fouten.

**Veerponten** (`pipeline/bike_ferry_check.py`):
- **Methode.** De ponten komen uit OSM (`osmium tags-filter … w/route=ferry`, `osmium export` naar `data/bike_grid/ferries.geojsonseq`). Per pont zoekt het script de kortste weg door het raster tussen de knopen bij beide aanlegplaatsen, met de ruwe OSRM-afstanden. "Mee" betekent hooguit 1,3 × de pontlengte + 1 km.
- **Uitkomst.** Van de 578 pontlijnen doen er 525 mee (NL-raster: 527). Het verschil zijn alleen de Borkum-veren, die nu knopen aan Duitse kant hebben.
- **De ponten die niet meedoen liggen aan OSM, niet aan de pijplijn:**
  - **Laag water.** Bronkhorsterveer, Dommerholtsveer (Gorssel–Wilp) en Kozakkenveer: sinds 5 aug 2026 staan de aanloopwegen op `access=no` met de notitie "pont vaart niet ivm laag water". Ook de publieke OSRM-server neemt ze niet. Dat herstelt zich bij een OSM-update nadat de notitie weg is; dan het raster opnieuw bouwen.
  - **Losse aanlegplaats.** Bijvoorbeeld Gorinchem–Woudrichem: het eindpunt in Woudrichem zit alleen aan andere ponten vast, niet aan een weg.
  - **Grote veerboten** (Waddeneilanden, Zierikzee, Noordzee): die ontbreken deels. Dat geeft niet, want ze zitten in de GTFS en zijn langer dan elke fietsgrens.
- **Beperking.** OSRM rekent een pont als fietsafstand. De wachttijd en de dienstregeling van kleine ponten (vaak alleen in de zomer) tellen niet mee.

## Fase 6 in detail: gebruikers en bereik (plan van 12 okt 2026)

Fase 6 maakt de site begrijpelijk en deelbaar voor bezoekers die niets van GTFS of Dijkstra weten. Het rekenmodel blijft zoals het is.

**Uitgangspunten:**
- Geen eigen backend. Alles blijft statisch op GitHub Pages.
- Geen cookies en geen persoonsgegevens, dus geen cookiebanner.
- De eerste kaart staat op 4G binnen enkele seconden.
- Bestaande deellinks (`#lat,lon,naam`) blijven werken.
- Het touchpatroon (tikken → infobox → "Vertrek vanaf hier") blijft.

### 6.1 Snelle winst (ongeveer twee avonden)

- **Instellingen in de deellink.** Optionele sleutels na het vertrekpunt, bijvoorbeeld `#52.08940,5.11000,Utrecht%20Centraal&w=0.5&v=15&b=5&d=15&t=180`. De sleutels zijn `w` (wachtfactor), `v` (fietssnelheid), `b` (bikeMaxKm), `d` (directMaxKm) en `t` (tMaxMin).
  - Alleen afwijkingen van de standaard komen in de URL.
  - `readHash()` leest eerst het oude deel en daarna de sleutels. Onbekende of ongeldige waarden worden genegeerd.
  - Elke schuif werkt de hash bij via `history.replaceState`.
  - Let op: de huidige regex in `main.ts` neemt alles na de tweede komma als naam. De naam moet dus ophouden bij de eerste `&`.
- **Deelknop.** Op mobiel `navigator.share()`, op desktop kopiëren met de melding "Link gekopieerd".
- **Open Graph en favicon.** Voeg `og:title`, `og:description`, `og:image` (`og.png`, 1200 × 630, heatmap vanaf Utrecht C) en `twitter:card` toe, plus een SVG-favicon met kleurbanden. De preview is voor elke link hetzelfde, want crawlers lezen de hash niet.
- **Uitleg.**
  - Eén zin onder de titel.
  - Een blok "Hoe werkt dit?" met de kleuren, de wachttijd en de beperkingen.
  - Gewone woorden voor de modellen: "Optimistisch (geen wachttijd)" en "Realistisch (met gemiddelde wachttijd)".
- **Mijn locatie.** Een knop die `navigator.geolocation` (of MapLibre `GeolocateControl`) gebruikt en dan `setOrigin()` aanroept. Bij weigeren of een positie buiten NL verschijnt een melding.
- **Voorbeeldchips** onder de zoekbalk: Amsterdam C, Groningen, Middelburg, Terschelling, Winterswijk. Elke chip is een gewone deellink.

### 6.2 Bezoekers meten

GoatCounter: gratis voor niet-commerciële sites en zonder cookies. Alternatief is Cloudflare Web Analytics, met minder mogelijkheden voor eigen gebeurtenissen.
1. Maak een account met de code `ovafstand`.
2. Zet in `index.html`: `<script data-goatcounter="https://ovafstand.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>`.
3. Tel eigen gebeurtenissen met `window.goatcounter?.count({ path, event: true })`:
   - `vertrekpunt-gekozen` (klik, zoeken, locatie of chip);
   - `gedeeld`;
   - later `animatie-gestart` en `vergelijken-gestart`.
4. Zet het tellen uit op `localhost`.

Stuur alleen het type gebeurtenis mee, nooit coördinaten of adressen.

### 6.3 Smartphone

- **Bottom sheet.** Tot 640 px wordt het paneel een sheet onderaan:
  - ingeklapt (±72 px): het vertrekpunt en de legenda;
  - half (±45%): de zoekbalk, de chips en de deelknop;
  - vol (±85%): de instellingen en de uitleg.

  Vegen of tikken op de greep wisselt de stand. Focus op de zoekbalk zet de sheet op vol. Na het kiezen van een vertrekpunt klapt hij in.
- **Infobox in de sheet.** De popup valt aan de rand soms buiten beeld. Op mobiel staat de reisinfo daarom in de sheet (half), met een grote knop "Vertrek vanaf hier". Op de kaart blijft alleen een markering.
- **Kleine punten:**
  - tikdoelen van minstens 44 × 44 px;
  - geen zoomknoppen op touch;
  - `env(safe-area-inset-*)` met `viewport-fit=cover`;
  - de legenda altijd zichtbaar;
  - de statusregel op mobiel verbergen.
- **Testen** op een iPhone (Safari) en een Android-toestel (Chrome), staand en liggend. `OffscreenCanvas` werkt pas vanaf iOS 16.4. Oudere toestellen moeten een duidelijke melding krijgen.

### 6.4 Animatie: een werkdag doorlopen

Begin met een uurmodel: per uur een statische graaf. Nog geen volledige dienstregelingsrouter. Het huidige model volstaat niet, om twee redenen:
- het venster 07–19 u is 's avonds te gunstig;
- de wachttijdgrens van 30 min maakt een nachtbus die eens per twee uur rijdt te aantrekkelijk.

- **Pipeline.** `build_graph.py` berekent per instapkant en per uur (24 vakken, of 48 halve uren) het interval en de kortste rijtijd. Zonder dienst is de waarde 65535. Het resultaat is een apart bestand `hours.bin` (±82.500 × 24 × 2 B ≈ 4 MB). Dat wordt pas geladen bij het starten van de animatie.
- **Wachttijd.** ½ interval zonder grens van 30 min. Een kant zonder dienst is dicht.
- **Over het uur heen.** De kosten van een instapkant hangen af van `vertrektijd + label`, niet van het vertrekuur. Dat is een kleine aanpassing in `router.ts`.
- **Afspelen:**
  - een tijdschuif van 00:00 tot 24:00 met een afspeelknop en een grote klok;
  - de worker rekent twee frames vooruit (±300 ms per frame);
  - een overgang van ±400 ms via twee `ImageSource`-lagen;
  - frames niet bewaren: 48 stuks kosten honderden MB;
  - onder de schuif een lijndiagram met het oppervlak dat per uur binnen 1 uur bereikbaar is.
- **Later.** Fase 4 (CSA) kan dezelfde schuif gebruiken. Neem dan per frame de mediaan over 12 vertrekmomenten, zodat het beeld niet springt.
- **Open punten:**
  - alleen werkdag, of ook zaterdag en zondag?
  - een demo vanaf Utrecht op de voorpagina?
  - een video exporteren met `MediaRecorder`?

### 6.5 Twee vertrekpunten vergelijken

Technisch is het steeds hetzelfde: twee Dijkstra-runs, twee rasters met minuten per cel en een rekensom per cel. Welke som je kiest, hangt af van de vraag van de bezoeker.

| Vraag | Per cel | Kleur | Voorbeeld |
|---|---|---|---|
| Waar zijn we allebei snel? | max(A, B) | huidige schaal | samen wonen, elk een eigen werk |
| Waar is de totale reistijd het laagst? | A + B | huidige schaal × 2 | twee forenzen |
| Wie is er dichterbij? | A − B | tweekleurig rond 0 | twee huizen of banen vergelijken |
| Waar spreken we af? | max(A, B), beste 5% | markering | afspreken in een andere stad |

**Voorstel:**
- Een knop "+ Vergelijk met…" voor punt B.
- Een schakelaar met twee standen: "Allebei snel" (max) en "Wie is dichterbij" (verschil).
- De tooltip toont beide routes, A en B elk in een eigen kleur.
- Deellink met `&m=max` of `&m=diff`. Gebruik voor punt B een eigen sleutel, bijvoorbeeld `&p2=52.51,6.09,Zwolle`. Het oorspronkelijke plan (daar "fase 5" genoemd) stelde `&b=` voor, maar die sleutel is al bikeMaxKm.

**Techniek:**
- `raster.ts` moet de minuten per cel bewaren als `Uint16Array` (±3 MB per raster). Pas daarna volgt de kleuring.
- A wordt gecachet, zodat slepen met B alleen B opnieuw rekent.
- De rekentijd is ±300 ms als één punt verandert en ±600 ms als beide veranderen.

**Open vragen:**
- Welke vraag komt eerst?
- Ook drie of meer punten? Dan werkt max nog, het verschil niet.
- Combineren met de animatie? Pas na 6.4.

### Resultaten fase 6.1: snelle winst (14 okt 2026)

Begonnen met 6.1 in plaats van 6.2 (keuze van de gebruiker). Op branch `fase6`.
- **Instellingen in de deellink.** De sleutels zijn `w v b d t` uit het plan, plus `f` voor de schakelaar "fietsen over de weg" (zie README, "Deellink").
  - De naam stopt bij de eerste `&`. Een `&` in een naam blijft werken, want die is gecodeerd als `%26`.
  - Een waarde telt alleen als het invoerveld hem kan tonen: binnen min/max en op de stap van de schuif, of een bestaande optie. Zo levert `d=99` de standaard op.
  - Elke wijziging werkt de hash bij via `replaceState`.
  - Een `hashchange` (een geplakte of getypte link) zet ontbrekende instellingen terug op de standaard.
- **Deelknop.** Op een touchscherm (`pointer: coarse`) `navigator.share()`, anders kopiëren naar het klembord met de melding "Link gekopieerd". Lukt kopiëren niet, dan verschijnt de link in een `prompt`.
- **Open Graph en favicon.**
  - `og:image` is `https://corvanessen.github.io/OVafstand/og.png`, een volledige URL zoals crawlers die willen. Bij een eigen domein aanpassen.
  - `og.png` (1200 × 630, 495 kB) is een screenshot van heel NL vanaf Utrecht C, met alleen de titel en de legenda in het paneel.
  - `favicon.svg` heeft concentrische banden uit de kleurschaal en het vertrekpunt in het midden.
- **Uitleg.**
  - Een nieuwe ondertitel: "Hoe lang ben je met trein, bus en fiets onderweg naar elke plek in Nederland?"
  - Een blok "Hoe werkt dit?" over de kleuren, de opbouw van een reis, realistisch en optimistisch, de beperkingen en de bronnen.
  - De modellen heten nu "Realistisch (met gemiddelde wachttijd)" en "Optimistisch (geen wachttijd)".
- **Mijn locatie.**
  - `navigator.geolocation` met `maximumAge: 0`, zodat een tweede klik geen oude positie oplevert.
  - Buiten het raster verschijnt "Je locatie ligt buiten de kaart". Bij weigeren verschijnt "Geen toestemming".
- **Voorbeeldchips.** Amsterdam C, Groningen, Middelburg, Terschelling en Winterswijk.
  - Elke chip is een gewone deellink, dus ook in een nieuw tabblad te openen.
  - Een gewone klik houdt de instellingen vast.
- **Klein.** Het legendalabel "3 u" brak af over twee regels; nu `nowrap`.
- **Getest in headless Chrome:**
  - een link met `&w=0&t=120&b=7.5&x=3&d=99&f=0` en een naam met `&`;
  - de hash na een schuif;
  - een chip;
  - delen met het klembord;
  - mijn locatie in Eindhoven en in Parijs, via `Emulation.setGeolocationOverride`;
  - een `hashchange` terug naar de standaard;
  - het favicon.

  Alles OK, zonder consolefouten. Ook gecontroleerd: `tsc`, `npm run build` en een screenshot op 390 px breed. Op een echt toestel is het nog niet getest: `navigator.share` en de locatie.

### Resultaten fase 6.2: bezoekers meten (14 okt 2026)

- **Account.** `ovafstand.goatcounter.com` (aangemaakt door de gebruiker). Het script staat in `index.html`, met `async`.
- **Wat er niet meegaat.** `count.js` stuurt alleen `pathname + search` mee, nooit de hash met het vertrekpunt. Op `localhost` en in privé-netwerken telt het niet (`allow_local` staat standaard uit). Gecontroleerd in de broncode van `count.js` en in Chrome: "not counting because of: localhost".
- **Eigen bezoeken uitzetten.** Open één keer `…/OVafstand/#toggle-goatcounter` in je eigen browser.
- **Gebeurtenissen** (`track()` in `main.ts`): elk is een eigen pad, zodat het dashboard ze apart telt. Het zijn alleen namen, zonder coördinaten of adressen.
  - `vertrekpunt-klik`, `-tik`, `-slepen`, `-zoeken`, `-voorbeeld` en `-locatie`. Het plan noemde één gebeurtenis `vertrekpunt-gekozen`, maar per bron leert meer.
  - `gedeeld-menu` (`navigator.share`) en `gedeeld-kopie` (klembord).
  - `uitleg-geopend` en `instellingen-geopend`.
  - Later: `animatie-gestart` en `vergelijken-gestart`.
- **In "Hoe werkt dit?"** staat: "Bezoeken worden geteld met GoatCounter, zonder cookies en zonder je locatie."
- **Getest in headless Chrome.** Met een recorder in plaats van `goatcounter.count` komen chip, uitleg, instellingen, delen, locatie en klik in de juiste volgorde binnen, zonder cijfers.
- **Nulmeting.** Er wordt pas geteld na een merge naar `main`, omdat Pages vanaf `main` publiceert.

### Resultaten fase 6.3: smartphone (14 okt 2026)

Op branch `fase6-smartphone`. Alles geldt onder 640 px breed; daarboven blijft het paneel zoals het was.
- **Bottom sheet** met `data-sheet` op `#panel`:
  - **ingeklapt:** het vertrekpunt en de legenda, ±117 px;
  - **half:** tot 45dvh; zoeken, chips, mijn locatie en delen;
  - **vol:** tot 85dvh; ook de hint, de instellingen, de uitleg en de voetregel.
- **Wisselen tussen de standen.**
  - Een greep bovenaan: tikken klapt open of dicht, vegen gaat een stand omhoog of omlaag.
  - De greep vangt `touchend` af. Anders kwam de nagestuurde klik na het inklappen op de kaart terecht, opende die de reisinfo en ging de sheet weer half open. Dat bleek in de test.
  - Focus op het zoekveld zet de sheet op vol.
  - Na een keuze (zoeken, chip, locatie of "Vertrek vanaf hier") klapt hij in.
  - Een eerste bezoek zonder hash begint half open; een gedeelde link ingeklapt.
- **Reisinfo in de sheet.** Tikken op de kaart toont de route boven in de sheet (half), met een sluitknop en een grote knop "Vertrek vanaf hier". Op de kaart staat dan alleen een blauwe ring. Op een breder touchscherm (tablet) blijft het de popup.
- **De legenda** blijft sticky onderaan de sheet in beeld, ook als die scrolt.
- **Kleine punten:**
  - Tikdoelen zijn ≥ 44 px: chips, knoppen, zoekveld, menukoppen en radioknoppen.
  - Het zoekveld heeft 16 px tekst, anders zoomt iOS in bij focus.
  - Geen zoomknoppen bij `pointer: coarse`.
  - `viewport-fit=cover` met `env(safe-area-inset-*)`.
  - De statusregel is verborgen.
  - De hint zegt "Tik op de kaart…".
  - De bronvermelding begint ingeklapt; MapLibre klapt die eerst uit, en dan bedekt hij een flink stuk kaart.
  - `--sheet-h` (via een `ResizeObserver`) houdt de kaartbediening en de meldingen boven de sheet.
  - Kaartpadding onderaan (30% van de hoogte), zodat het vertrekpunt boven de halfopen sheet valt.
- **Oude browsers.** Zonder `OffscreenCanvas` of `DecompressionStream` (iOS < 16.4) start de worker niet. Er verschijnt dan "Je browser is te oud voor deze kaart. Op een iPhone of iPad is iOS 16.4 of nieuwer nodig."
- **Getest in headless Chrome** als telefoon (390 × 844, touch-emulatie, tikken en vegen via `Input.dispatchTouchEvent`). Alle 22 controles zijn OK, zonder consolefouten, en ook de desktoptests van 6.1 zijn nog OK.
  - Gecontroleerd: de standen, de chip, de tik op de kaart, "Vertrek vanaf hier", vegen omhoog en omlaag, tikken op de greep, de focus op het zoekveld, de tikdoelen, de positie van de kaartbediening en de melding voor oude browsers.
  - **Nog niet gedaan:** een echte iPhone (Safari) en een Android-toestel, staand en liggend.

### 6.6 Volgorde

Eerst meten en delen, dan de grote features.
1. Bezoekers meten (6.2): een half uur, als nulmeting.
2. Snelle winst (6.1).
3. Smartphone (6.3).
4. Animatie (6.4): eerst het uurmodel, dan de tijdschuif.
5. Vergelijken (6.5).

Stap 4 en 5 kunnen in beide volgordes.

**Open vraag:** een eigen domeinnaam? Dat kan met GitHub Pages.
