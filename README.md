# Wayfinder Chennai

**Live demo:** [Open Wayfinder Chennai](https://wayfinder-chennai.onrender.com)

An accessible multimodal journey-planning project for Chennai. It combines mapped pedestrian routing, CMRL Phase I station sequences, MTC route/stop patterns, browser speech, and on-device webcam object labeling.

## Run locally

Requirements: Node.js 22 or newer and an internet connection for map tiles, geocoding/routing, Leaflet, and the first COCO-SSD model download.

```sh
cd chennai-wayfinder
node server.js
```

Open <http://localhost:4173>. No package install, API key, special camera, or external hardware is required. An ordinary laptop webcam or phone camera is enough. A wider lens can show more of the scene, but a 180° camera is not required.

## Deploy a public demo

This project is a Node web service, not a static-only site: it uses `/api/geocode` and `/api/pedestrian-route` for server-side map requests. The included `render.yaml` deploys it as a Render web service on the free plan with a health check. Push the project to GitHub, then in Render choose **New → Blueprint** and select that repository. Render will show the service settings before creating it.

The free service sleeps after 15 minutes without traffic and its first request after sleep can take about a minute. It is suitable for a portfolio demo, not dependable trip planning. The public OpenStreetMap geocoder has a strict application-wide limit of one request per second; this app queues searches and caches responses in memory. Its community foot-routing server and map tiles also have no availability guarantee. Review the linked service policies before wider use.

## What works

- **Offline-Ready PWA**: Includes a Web App Manifest and Service Worker with Cache API caching. Once visited, the app shell and the entire bundled Chennai GTFS transit dataset are accessible offline when commuting in low-connectivity areas or underground CMRL corridors.
- **Multimodal Transit Planning**:
  - Resolves known CMRL stations and MTC stops directly from the bundled Chennai data, then searches other places on explicit submit with OpenStreetMap Nominatim with rate limiting and in-memory caching.
  - Builds CMRL Phase I Blue/Green Line station sequences from official station lists with schematic track links and CMRL travel planner integration.
  - Finds MTC bus route patterns from bundled GTFS stops, routes, and trips with accessible boarding filters.
- **Pedestrian Routing & Chennai Street Insights**:
  - Requests turn-by-turn foot directions from OpenStreetMap routing community server.
  - Scans routes for Chennai arterial corridors (Anna Salai, Poonamallee High Road, GST Road, OMR, 100 Feet Road, Sardar Patel Road) to surface localized pedestrian crossing cautions and weather advisories.
- **Proximity & Direction-Aware Vision Assist**:
  - Connects a phone camera or laptop webcam and runs TensorFlow.js COCO-SSD on-device.
  - Analyzes bounding box coverage and horizontal position to classify obstacle **proximity** (Close / Moderate) and **direction** (Left / Ahead / Right).
  - Triggers **Haptic Vibration pulses** (on supported mobile devices) and directional speech warnings when an obstacle is directly in the walking path.
  - Features configurable scan rates (Battery Saver 0.8 FPS, Balanced 1.3 FPS, Responsive 2.5 FPS) and background tab pausing to prevent smartphone thermal throttling.
- **Audio-First Mode**:
  - Comprehensive voice navigation and controls via SpeechRecognition and SpeechSynthesis (e.g., *"from Central to Airport"*, *"walk"*, *"metro"*, *"bus"*, *"next"*, *"repeat"*, *"start camera"*, *"test vibration"*, *"help"*).

## Data provenance and important limits

### Chennai MTC GTFS

`data/chennai-transit.json` is a compact derived index generated from the Chennai GTFS community feed. Source: [UngalSoththu / ChennaiGTFS](https://github.com/ungalsoththu/ChennaiGTFS). The feed's own `feed_info.txt` says its service validity ends **2025-12-31**. The repository documents that the MTC data was collected from the MTC app and that route shapes are not road-matched. Therefore this app treats MTC paths as **historical route patterns**, not a promise that a bus currently runs, a current timetable, or live arrival data. Do not use it to make time-critical travel decisions. Chennai currently has no live MTC vehicle-position feed available to this app.

### Chennai Metro

Station names and order are taken from [CMRL's official Blue Line list](https://chennaimetrorail.org/bd-category/business-development/to-know-station-wise/blue-line/) and [Green Line list](https://chennaimetrorail.org/bd-category/business-development/to-know-station-wise/green-line/). Coordinates are from the community GTFS stop file. The colored lines drawn between stations are schematic connections, not track geometry. Current service times, fares, lift status, and station accessibility are not provided by this app; use the [official CMRL trip planner](https://travelplanner.chennaimetrorail.org/).

### Map and pedestrian routing

The background map uses [OpenStreetMap](https://www.openstreetmap.org/copyright) and requires visible attribution. Pedestrian directions are requested from the community-hosted [OpenStreetMap routing server](https://routing.openstreetmap.de/). Availability can change and this public service has no guarantee. Its foot profile is not a wheelchair profile. A pedestrian route is not proof of step-free access, safe crossings, clear sidewalks, or current conditions. The app reports accessibility as unknown when the source does not provide it.

Nominatim is called only after a person submits a place search; no autocomplete or bulk geocoding is used. The server identifies the app and derives the Referer from the public request host. See the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). For broader use, select service providers whose terms and capacity match the deployment.

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
