#!/usr/bin/env bash
# Fase 3: lokale OSRM-fietsserver in WSL (Ubuntu + docker.io).
#
# Gebruik (in Ubuntu):  bash pipeline/osrm_setup.sh          alleen NL: downloaden, verwerken en starten
#                       bash pipeline/osrm_setup.sh grens    NL plus de strook BE en DE binnen het kaartraster
#                       bash pipeline/osrm_setup.sh start    alleen de server (opnieuw) starten
#                                                            (het grensextract als dat er is, anders NL)
#
# Data staat in ~/osrm (in het Linux-bestandssysteem, veel sneller dan /mnt/c).
# De server luistert op http://localhost:5000, ook bereikbaar vanuit Windows.
set -euo pipefail

DIR=~/osrm
GEOFABRIK=https://download.geofabrik.de/europe
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
DOCKER=/usr/bin/docker   # niet de shim van Docker Desktop in /mnt/c
NAME=osrm-fiets
BBOX=3.2,50.6,7.4,53.7   # gelijk aan grid.ts
# buurlanden binnen BBOX: België, Noordrijn-Westfalen, Nedersaksen (Emsland, Bentheim, Leer)
BUREN="belgium germany/nordrhein-westfalen germany/niedersachsen"

mkdir -p "$DIR"
cd "$DIR"
run() { $DOCKER run --rm -t -v "$DIR:/data" "$IMG" "$@"; }
osmium() { $DOCKER run --rm -v "$DIR:/data" -w /data osmium-tool osmium "$@"; }
get() { local f; f=$(basename "$1"); curl -fsSL -R -z "$f" -o "$f" "$GEOFABRIK/$1"; }   # alleen als Geofabrik nieuwer is

process() {   # $1 = naam zonder .osm.pbf
  $DOCKER stop "$NAME" >/dev/null 2>&1 || true   # geheugen vrij voor osrm-extract
  echo "== extract (fietsprofiel)"
  run osrm-extract -p /opt/bicycle.lua "/data/$1.osm.pbf"
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
  *) echo "onbekend: $1 (nl | grens | start)"; exit 1 ;;
esac

echo "== server starten op :5000 met $BASE"
$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
$DOCKER run -d --restart unless-stopped --name "$NAME" -p 5000:5000 -v "$DIR:/data" "$IMG" \
  osrm-routed --algorithm mld --max-table-size 10000 "/data/$BASE.osrm"
echo "klaar: curl 'http://localhost:5000/route/v1/bike/5.11,52.09;5.12,52.10'"
