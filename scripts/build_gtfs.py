"""Create a compact Chennai route/stop index from a public GTFS zip.

Usage: python scripts/build_gtfs.py path/to/chennai-unified-gtfs.zip
The output is derived from the GTFS feed and remains subject to its data license.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://github.com/ungalsoththu/ChennaiGTFS"
BOUNDS = (12.45, 79.85, 13.45, 80.55)  # south, west, north, east; Chennai metro area


def rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as handle:
        yield from csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig", newline=""))


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Pass the path to the Chennai unified GTFS zip")
    source = Path(sys.argv[1])
    today = dt.date.today()
    south, west, north, east = BOUNDS

    with zipfile.ZipFile(source) as zf:
        feed_info = next(rows(zf, "feed_info.txt"), {})
        agencies = list(rows(zf, "agency.txt"))
        stops = {}
        for row in rows(zf, "stops.txt"):
            try:
                lat, lon = float(row["stop_lat"]), float(row["stop_lon"])
            except (KeyError, ValueError):
                continue
            if south <= lat <= north and west <= lon <= east:
                stops[row["stop_id"]] = {
                    "id": row["stop_id"], "name": row.get("stop_name", "Transit stop"),
                    "lat": lat, "lon": lon, "wheelchair": row.get("wheelchair_boarding", ""),
                    "code": row.get("stop_code", ""),
                }

        routes = {r["route_id"]: r for r in rows(zf, "routes.txt")}
        trips = {}
        for trip in rows(zf, "trips.txt"):
            trips[trip["trip_id"]] = trip
        trip_patterns = {}
        for stop_time in rows(zf, "stop_times.txt"):
            trip = trips.get(stop_time.get("trip_id", ""))
            if not trip:
                continue
            stop_id = stop_time.get("stop_id", "")
            if stop_id not in stops:
                continue
            trip_patterns.setdefault(trip["trip_id"], []).append((int(stop_time.get("stop_sequence", "0")), stop_id))

    output_routes = []
    seen = set()
    for trip_id, sequence in trip_patterns.items():
        sequence.sort()
        stop_ids = [sid for _, sid in sequence]
        if len(stop_ids) < 2:
            continue
        trip = trips[trip_id]
        route_id, direction = trip["route_id"], trip.get("direction_id", "0")
        signature = (route_id, direction, tuple(stop_ids))
        if signature in seen:
            continue
        seen.add(signature)
        route = routes.get(route_id, {})
        agency_id = route.get("agency_id", "")
        agency_name = next((a.get("agency_name", "Transit") for a in agencies if a.get("agency_id") == agency_id), "Chennai transit")
        output_routes.append({
            "id": route_id, "short": route.get("route_short_name", ""),
            "name": route.get("route_long_name", ""), "type": route.get("route_type", ""),
            "agency": agency_name, "direction": direction, "stops": stop_ids,
        })

    payload = {
        "city": "Chennai", "bounds": list(BOUNDS),
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "feedDateRange": {"start": feed_info.get("feed_start_date", ""), "end": feed_info.get("feed_end_date", "")},
        "source": SOURCE_URL,
        "license": "ODbL-1.0; attribute UngalSoththu / Ithu Ungal Soththu and publish database derivatives under ODbL",
        "stops": list(stops.values()), "routes": output_routes,
    }
    stop_index = {stop["id"]: stop for stop in payload["stops"]}
    blue_ids = [f"CMRL_{i:02d}" for i in range(1, 27)]
    green_ids = ["CMRL_G01", "CMRL_G02", "CMRL_G03", "CMRL_G04", "CMRL_G05", "CMRL_G06", "CMRL_G07", "CMRL_G08", "CMRL_G09", "CMRL_G10", "CMRL_G12", "CMRL_G13", "CMRL_G14", "CMRL_G15", "CMRL_G16", "CMRL_G17", "CMRL_G18"]
    payload["metroLines"] = []
    for line_id, line_name, station_ids in (("blue", "Blue Line", blue_ids), ("green", "Green Line", green_ids)):
        line_stations = [stop_index[sid] for sid in station_ids if sid in stop_index]
        if len(line_stations) > 2:
            payload["metroLines"].append({"id": line_id, "name": line_name, "stations": line_stations})
    payload["metroSource"] = "https://chennaimetrorail.org/bd-category/business-development/to-know-station-wise/blue-line/"
    target = ROOT / "data" / "chennai-transit.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    print(f"Wrote {target}: {len(stops)} stops, {len(output_routes)} route patterns")
    print(f"GTFS zip SHA-256: {digest}")


if __name__ == "__main__":
    main()
