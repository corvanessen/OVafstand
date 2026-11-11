"""Ritten per vervoerder per dag, om een dag te kiezen waarop iedereen rijdt.

Gebruik:  python pipeline/feed_days.py [zip] YYYYMMDD [YYYYMMDD ...]
Toont per vervoerder het aantal ritten per gekozen dag, plus de eerste en laatste dag met ritten.
Vervoerders zonder ritten op een gekozen dag staan bovenaan (met een !). Vervoerders kunnen eerder
stoppen dan feed_end_date: in de feed van 10 okt 2026 stopte HTM op 8 nov.
"""
import collections
import csv
import io
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    args = sys.argv[1:]
    zpath = Path(args.pop(0)) if args and args[0].endswith(".zip") else ROOT / "data" / "raw" / "gtfs-nl.zip"
    days = args
    if not days:
        sys.exit(__doc__)
    z = zipfile.ZipFile(zpath)
    read = lambda name: csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig"))
    agency_of_route = {r["route_id"]: r["agency_id"] for r in read("routes.txt")}
    trips_per_service = collections.defaultdict(collections.Counter)
    for r in read("trips.txt"):
        trips_per_service[r["service_id"]][agency_of_route[r["route_id"]]] += 1
    count = {d: collections.Counter() for d in days}
    first, last = {}, {}
    for r in read("calendar_dates.txt"):
        if r["exception_type"] != "1":
            continue
        d = r["date"]
        for ag in trips_per_service[r["service_id"]]:
            first[ag] = min(first.get(ag, d), d)
            last[ag] = max(last.get(ag, d), d)
        if d in count:
            count[d].update(trips_per_service[r["service_id"]])
    agencies = sorted(first, key=lambda a: (all(count[d][a] for d in days), a))
    print(f"{'vervoerder':<24}" + "".join(f"{d:>10}" for d in days) + "     eerste    laatste")
    for a in agencies:
        mark = " " if all(count[d][a] for d in days) else "!"
        print(f"{mark}{a[:23]:<23}" + "".join(f"{count[d][a]:>10}" for d in days) + f"  {first[a]}  {last[a]}")


if __name__ == "__main__":
    main()
