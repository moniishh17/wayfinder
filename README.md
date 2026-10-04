# Wayfinder Chennai

An accessible multimodal journey-planning project for Chennai. It combines mapped pedestrian routing, CMRL Phase I station sequences, MTC route/stop patterns, browser speech, and on-device webcam object labeling.

## Run locally

Requirements: Node.js 18 or newer and an internet connection for map tiles, geocoding/routing, Leaflet, and the first COCO-SSD model download.

```sh
cd chennai-wayfinder
node server.js
```

Open <http://localhost:4173>. No package install, API key, special camera, or external hardware is required. An ordinary laptop webcam or phone camera is enough. A wider lens can show more of the scene, but a 180° camera is not required.

## What works

- Resolves known CMRL stations and MTC stops directly from the bundled Chennai data, then searches other places on explicit submit with OpenStreetMap Nominatim. The small Node server adds an application identifier, rate-limits requests, and caches results.
- Requests a pedestrian route from the OpenStreetMap routing community server and draws its actual route geometry and directions on Leaflet. This does not confirm wheelchair access or safe sidewalk conditions.
- Finds MTC bus route patterns from a bundled extract of Chennai GTFS stops, routes, trips, and stop times. Candidate ranking uses the straight-line distance to boarding/alighting stops and transfer count; it does not claim to minimize travel time.
- Builds CMRL Phase I Blue/Green Line station sequences from current official CMRL station lists, using station coordinates in the Chennai GTFS stop file. It draws a schematic between station points and links to CMRL's official planner for current train times and fares.
- Offers speech output and browser-supported speech input for route lookup and navigation controls.
- Connects a phone or webcam and runs TensorFlow.js COCO-SSD object labeling in the browser. Video frames stay on the device. The model names common objects; it does not detect curb ramps, stairs, sidewalk quality, or whether a detected object blocks a route. It never changes the route or claims a path is safe.

## Data provenance and important limits

### Chennai MTC GTFS

`data/chennai-transit.json` is a compact derived index generated from the Chennai GTFS community feed. Source: [UngalSoththu / ChennaiGTFS](https://github.com/ungalsoththu/ChennaiGTFS). The feed's own `feed_info.txt` says its service validity ends **2025-12-31**. The repository documents that the MTC data was collected from the MTC app and that route shapes are not road-matched. Therefore this app treats MTC paths as **historical route patterns**, not a promise that a bus currently runs, a current timetable, or live arrival data. Do not use it to make time-critical travel decisions. Chennai currently has no live MTC vehicle-position feed available to this app.

### Chennai Metro

Station names and order are taken from [CMRL's official Blue Line list](https://chennaimetrorail.org/bd-category/business-development/to-know-station-wise/blue-line/) and [Green Line list](https://chennaimetrorail.org/bd-category/business-development/to-know-station-wise/green-line/). Coordinates are from the community GTFS stop file. The colored lines drawn between stations are schematic connections, not track geometry. Current service times, fares, lift status, and station accessibility are not provided by this app; use the [official CMRL trip planner](https://travelplanner.chennaimetrorail.org/).

### Map and pedestrian routing

The background map uses [OpenStreetMap](https://www.openstreetmap.org/copyright) and requires visible attribution. Pedestrian directions are requested from the community-hosted [OpenStreetMap routing server](https://routing.openstreetmap.de/). Availability can change and this public service has no guarantee. Its foot profile is not a wheelchair profile. A pedestrian route is not proof of step-free access, safe crossings, clear sidewalks, or current conditions. The app reports accessibility as unknown when the source does not provide it.

Nominatim is called only after a person submits a place search; no autocomplete or bulk geocoding is used. See the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). For a public deployment, set an application-specific contact/referer and select service providers whose terms and capacity match the deployment.

## License notes

- Application source: MIT (see `LICENSE`).
- The derived MTC transit database is attributed to UngalSoththu / Ithu Ungal Soththu and distributed under ODbL-1.0 in line with the source repository's data notice (see `data/ODbL-NOTICE.md`). Database derivatives must retain attribution and share-alike terms.
- Leaflet, TensorFlow.js, and COCO-SSD are third-party software/model assets loaded from their public CDNs. Their respective licenses apply.

## Refresh the transit index

Download the latest Chennai unified GTFS zip from the source repository, then run:

```sh
python scripts/build_gtfs.py path/to/chennai-unified-gtfs.zip
```

The script writes the compact stop/route index and keeps the publisher's feed-validity dates so stale data is visible. Review the source feed and license before refreshing or redistributing data.
