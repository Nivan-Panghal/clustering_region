# GeoViz — Geospatial Demand Clustering Backend

A geospatial backend that divides a geographic region into demand zones using **K-Means clustering on KML boundary data**, stores the zones in **PostGIS**, and serves a **FastAPI** API that maps field requests to zones and reports live demand intensity per zone.

A KML file contains the boundary coordinates (latitude and longitude) of a region. The generator samples random points inside that boundary, groups them into clusters with K-Means using Euclidean distance in a metric (UTM) projection, and writes a JSON file with each zone's boundary coordinates. Zones are the areas closest to each cluster center, so they cover the region with no gaps and no overlaps. When a client submits a location, the FastAPI backend runs a spatial query to find which zone contains the coordinates and returns it.

A KML boundary can be created with Google Earth or QGIS by tracing the outline of a region, or taken from the ISRO Bhuvan site. A made-up sample boundary (`sample_boundary.kml`) is included so the whole pipeline can be tried straight away.

---

## What It Does

1. **Boundary Ingestion** — Parses a KML file defining a region's geographic boundary
2. **Zone Generation** — Runs K-Means (scikit-learn) on sampled points inside the boundary to divide it into N non-overlapping service zones
3. **PostGIS Storage** — `seed_db.py` loads the zones into PostGIS geometry columns for fast spatial queries
4. **Request Collection** — Clients submit geo-tagged service requests through the API
5. **Demand Data** — The API returns each zone with its request count, urgency score and a color from green to red, ready to draw on any map

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | FastAPI (Python) |
| Database | PostgreSQL + PostGIS |
| Spatial Clustering | scikit-learn K-Means + GeoPandas + Shapely |

---

## Project Structure

```
clustering_region/
│
├── cluster_generator.py      # KML → K-Means → zone polygons (JSON)
├── seed_db.py                # loads the JSON into PostGIS
├── main.py                   # FastAPI backend
├── Schema.sql                # database schema (PostGIS)
├── sample_boundary.kml       # made-up sample region to try the pipeline
├── requirements.txt          # runtime dependencies (pinned)
├── requirements-dev.txt      # + test tools
├── .env.example              # settings template
├── tests/                    # pytest suite
├── Readme.md
└── .gitignore
```

---

## Setup & Run

### 1. Prerequisites
- Python 3.10+
- PostgreSQL 14+ with the PostGIS extension

### 2. Configure
```bash
cp .env.example .env      # then edit .env: set DB_PASSWORD (required) and the other DB_* values
```
`.env` is git-ignored. The API will not start without `DB_PASSWORD`.

### 3. Database Setup
```bash
psql -U postgres -c "CREATE DATABASE geodemand;"
psql -U postgres -d geodemand -c "CREATE EXTENSION postgis;"
psql -U postgres -d geodemand -f Schema.sql
```

### 4. Generate zones from a KML boundary
```bash
pip install -r requirements.txt
python cluster_generator.py                                   # uses sample_boundary.kml
python cluster_generator.py --kml my_region.kml --clusters 25 # custom region
```
This writes `clusters_output.json` and a preview image `clusters_preview.png`. Run `python cluster_generator.py -h` for all options.

### 5. Load the zones into the database
```bash
python seed_db.py --input clusters_output.json --region "Sample Region" --state Haryana  --district Gurugram
```
`--replace` overwrites a region that was loaded earlier. `--state` and `--district` also add the region to the search endpoint.

### 6. Run the API
```bash
uvicorn main:app --reload
# API runs at http://localhost:8000 (interactive docs at /docs)
```

### Tests
```bash
pip install -r requirements-dev.txt
pytest
```
Tests that need a database run when the `DB_*` settings point at a PostGIS database, and are skipped otherwise. They create and remove their own test data.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/find-zone` | Given lat/lng, returns which zone it falls in |
| `POST` | `/api/service-request` | Submit a field request with GPS + status (`low`, `medium`, `high`, `full`); resubmitting the same `request_id` replaces it |
| `DELETE` | `/api/service-request/{id}` | Delete a request |
| `GET` | `/api/zone-demand-map/{region}` | Zone polygons + live demand counts |
| `GET` | `/api/region-boundary/{region}` | Outer boundary polygon of a region |
| `GET` | `/api/search-regions/{query}` | Search available regions |

Errors use normal HTTP status codes (`422` invalid input, `404` not found, `500` server error with no internal details).

---

## Security notes

- **Authentication.** The API has no user accounts. A `request_id` acts as the secret for its own request: it is known only to the client that created it and is never returned by the API. Clients are expected to generate it randomly (a UUID4 works). Because there is no login, the API is meant to run on a trusted network or behind an authenticating gateway, not directly on the public internet.
- **CORS.** Only the origins in `CORS_ORIGINS` can call the API from a browser (default: `localhost:3000` and `localhost:5173`).
- **Network.** The server listens on `127.0.0.1` by default. Setting `API_HOST=0.0.0.0` (or passing `--host 0.0.0.0` to uvicorn) exposes it on every network interface.
- **Privacy.** Requests store GPS coordinates and the demand map returns pin locations, so the data is personal data.
- **Secrets.** Database credentials are read from `.env` or from environment variables, never from the code. `.env` is git-ignored.
