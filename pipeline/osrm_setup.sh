#!/usr/bin/env bash
# Fase 3: lokale OSRM-fietsserver in WSL (Ubuntu + docker.io).
#
# Gebruik (in Ubuntu):  bash pipeline/osrm_setup.sh          alleen NL: downloaden, verwerken en starten
#                       bash pipeline/osrm_setup.sh grens    NL plus de strook BE en DE binnen het kaartraster
#                       bash pipeline/osrm_setup.sh start    alleen de server (opnieuw) starten
#                                                            (het grensextract als dat er is, anders NL)
#                       bash pipeline/osrm_setup.sh voet     loopserver op het grensextract (foot.lua), naast de fietsserver
#                       bash pipeline/osrm_setup.sh voet-start   alleen de loopserver (opnieuw) starten
#
# Data staat in ~/osrm (in het Linux-bestandssysteem, veel sneller dan /mnt/c).
# De fietsserver luistert op http://localhost:5000, de loopserver op :5001, ook bereikbaar vanuit Windows.
set -euo pipefail

DIR=~/osrm
GEOFABRIK=https://download.geofabrik.de/europe
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
DOCKER=/usr/bin/docker   # niet de shim van Docker Desktop in /mnt/c
NAME=osrm-fiets
PROFILE=bicycle
PORT=5000
BBOX=3.2,50.6,7.4,53.7   # gelijk aan grid.ts
# buurlanden binnen BBOX: België, Noordrijn-Westfalen, Nedersaksen (Emsland, Bentheim, Leer)
BUREN="belgium germany/nordrhein-westfalen germany/niedersachsen"

mkdir -p "$DIR"
cd "$DIR"
MOUNTS=()         # extra bind-mounts voor de verwerking (zie voet)
SERVE_MOUNTS=()   # extra bind-mounts voor de server (zie voet)
run() { $DOCKER run --rm -t -v "$DIR:/data" "${MOUNTS[@]}" "$IMG" "$@"; }
osmium() { $DOCKER run --rm -v "$DIR:/data" -w /data osmium-tool osmium "$@"; }
get() { local f; f=$(basename "$1"); curl -fsSL -R -z "$f" -o "$f" "$GEOFABRIK/$1"; }   # alleen als Geofabrik nieuwer is

process() {   # $1 = naam zonder .osm.pbf
  $DOCKER stop "$NAME" >/dev/null 2>&1 || true   # geheugen vrij voor osrm-extract
  echo "== extract ($PROFILE)"
  run osrm-extract -p "/opt/$PROFILE.lua" "/data/$1.osm.pbf"
  echo "== partition"
  run osrm-partition "/data/$1.osrm"
  echo "== customize"
  run osrm-customize "/data/$1.osrm"
}

case "${1:-nl}" in
  nl)
    echo "== download netherlands-latest.osm.pbf"
    get netherlands-latest.osm.pbf
    process netherlands-latest
    BASE=netherlands-latest
    ;;
  grens)
    if ! $DOCKER image inspect osmium-tool >/dev/null 2>&1; then
      echo "== image osmium-tool bouwen"
      printf 'FROM debian:trixie-slim\nRUN apt-get update && apt-get install -y --no-install-recommends osmium-tool && rm -rf /var/lib/apt/lists/*\n' \
        | $DOCKER build -t osmium-tool -
    fi
    delen=()
    for land in netherlands $BUREN; do
      f=$(basename "$land")-latest.osm.pbf
      echo "== download $f"
      get "$land-latest.osm.pbf"
      echo "== knippen $f op $BBOX"
      osmium extract -b "$BBOX" --overwrite -o "bbox-$f" "$f"
      delen+=("bbox-$f")
    done
    echo "== samenvoegen"
    osmium merge --overwrite -o grens.osm.pbf "${delen[@]}"
    rm -f "${delen[@]}"
    process grens
    BASE=grens
    ;;
  start)
    BASE=netherlands-latest
    [[ -f grens.osrm.mldgr ]] && BASE=grens
    ;;
  voet|voet-start)
    # zelfde grensextract, ander profiel; een eigen naam (grens-voet) zodat de OSRM-bestanden niet botsen.
    # OSRM_VOET_DIR kiest een andere map voor de uitvoer, bijv. /mnt/d/osrm als C: te vol is (±6 GB plus werkruimte).
    # De invoer komt dan als los bestand uit ~/osrm in de container: geen kopie van 2,4 GB, en minder lezen via /mnt.
    # (11 nov 2026: een kopie op een externe SSD gaf "Read failed: Input/output error", waarschijnlijk de kabel.)
    NAME=osrm-voet PROFILE=foot PORT=5001 BASE=grens-voet
    [[ -f grens.osm.pbf ]] || { echo "eerst: bash pipeline/osrm_setup.sh grens"; exit 1; }
    SRC=$DIR/grens.osm.pbf
    DIR=${OSRM_VOET_DIR:-$DIR}
    mkdir -p "$DIR"
    cd "$DIR"
    if [[ $DIR == ~/osrm ]]; then ln -sf grens.osm.pbf grens-voet.osm.pbf
    else MOUNTS=(-v "$SRC:/data/grens-voet.osm.pbf:ro")
    fi
    if [[ $1 == voet ]]; then process grens-voet; fi
    # anders start de server zonder data en blijft hij herstarten (--restart unless-stopped), terwijl dit script "klaar" zegt
    [[ -f grens-voet.osrm.mldgr ]] || { echo "geen grens-voet in $DIR; zet OSRM_VOET_DIR (bijv. /mnt/d/osrm) of bouw eerst met: voet"; exit 1; }
    if [[ $DIR != ~/osrm ]]; then
      # osrm-routed leest de ruimtelijke index (.fileIndex) bij elke vraag via mmap. Een hapering van de externe
      # schijf gaf SIGBUS (11 nov 2026). Daarom staat die index (±0,5 GB) op de WSL-schijf; de rest leest hij bij de start.
      cp -u grens-voet.osrm.fileIndex ~/osrm/grens-voet.osrm.fileIndex
      SERVE_MOUNTS=(-v ~/osrm/grens-voet.osrm.fileIndex:/data/grens-voet.osrm.fileIndex:ro)
    fi
    ;;
  *) echo "onbekend: $1 (nl | grens | start | voet | voet-start)"; exit 1 ;;
esac

echo "== server $NAME starten op :$PORT met $BASE"
$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
# --ulimit core=0: een crash schreef een core dump van 3,8 GB in de container (11 nov 2026)
$DOCKER run -d --restart unless-stopped --ulimit core=0 --name "$NAME" -p "$PORT:5000" -v "$DIR:/data" "${SERVE_MOUNTS[@]}" "$IMG" \
  osrm-routed --algorithm mld --max-table-size 10000 "/data/$BASE.osrm"
echo "klaar: curl 'http://localhost:$PORT/route/v1/x/5.11,52.09;5.12,52.10'"
