#!/usr/bin/env bash
# Fase 3: lokale OSRM-fietsserver in WSL (Ubuntu + docker.io).
#
# Gebruik (in Ubuntu):  bash pipeline/osrm_setup.sh          downloaden, verwerken en starten
#                       bash pipeline/osrm_setup.sh start    alleen de server (opnieuw) starten
#
# Data staat in ~/osrm (in het Linux-bestandssysteem, veel sneller dan /mnt/c).
# De server luistert op http://localhost:5000, ook bereikbaar vanuit Windows.
set -euo pipefail

DIR=~/osrm
PBF=netherlands-latest.osm.pbf
URL=https://download.geofabrik.de/europe/$PBF
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
DOCKER=/usr/bin/docker   # niet de shim van Docker Desktop in /mnt/c
NAME=osrm-fiets

mkdir -p "$DIR"
cd "$DIR"
run() { $DOCKER run --rm -t -v "$DIR:/data" "$IMG" "$@"; }

if [[ "${1:-}" != "start" ]]; then
  echo "== download $PBF"
  wget -c -nv "$URL"
  echo "== extract (fietsprofiel)"
  run osrm-extract -p /opt/bicycle.lua "/data/$PBF"
  echo "== partition"
  run osrm-partition /data/netherlands-latest.osrm
  echo "== customize"
  run osrm-customize /data/netherlands-latest.osrm
fi

echo "== server starten op :5000"
$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
$DOCKER run -d --restart unless-stopped --name "$NAME" -p 5000:5000 -v "$DIR:/data" "$IMG" \
  osrm-routed --algorithm mld --max-table-size 10000 /data/netherlands-latest.osrm
echo "klaar: curl 'http://localhost:5000/route/v1/bike/5.11,52.09;5.12,52.10'"
