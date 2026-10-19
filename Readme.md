# GeoViz — Geospatial Demand Clustering Backend

A geospatial backend that divides a geographic region into demand clusters using **K-Means clustering on KML boundary data**, stores the zones in **PostGIS**, and serves a **FastAPI** API that maps field requests to zones and reports live demand intensity per zone.

A KML file contains the boundary coordinates (latitude and longitude) of a region. The generator samples random points inside that boundary, groups them into clusters with K-Means using Euclidean distance in a metric (UTM) projection, and writes a JSON file with each cluster's boundary coordinates. When a client submits a location, the FastAPI backend runs a spatial query to find which cluster polygon contains the coordinates and returns the matching service zone.

You can create a KML boundary with tools like Google Earth or QGIS by tracing the outline of a region, or get one from the ISRO Bhuvan site.

---

## What It Does

1. **Boundary Ingestion** — Parses a KML file defining a region's geographic boundary
2. **Cluster Generation** — Runs K-Means (scikit-learn) on sampled points inside the boundary to divide it into N service zones
3. **PostGIS Storage** — The schema stores cluster polygons as PostGIS geometry for fast spatial queries (loading `clusters_output.json` into `region_clusters` is a manual step; there is no seed script yet)
4. **Request Collection** — Clients submit geo-tagged service requests through the API
5. **Demand Data** — The API returns each cluster zone with its request count, urgency score and a color from green to red, ready to draw on any map

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | FastAPI (Python) |
| Database | PostgreSQL + PostGIS |
| Spatial Clustering | scikit-learn K-Means + GeoPandas |

---

## Project Structure

```
clustering_region/
│
├── cluster_generator.py      # KML → K-Means → cluster polygons (JSON)
├── main.py                   # FastAPI backend
├── requirements.txt
├── Schema.sql                # Database schema (PostGIS)
├── Readme.md
└── .gitignore
```

---

## Setup & Run

### 1. Prerequisites
- Python 3.10+
- PostgreSQL 14+ with the PostGIS extension

### 2. Database Setup
```bash
# Create database and enable PostGIS
psql -U postgres -c "CREATE DATABASE geodemand;"
psql -U postgres -d geodemand -c "CREATE EXTENSION postgis;"

# Run schema
psql -U postgres -d geodemand -f Schema.sql
```

### 3. Generate Clusters from KML
```bash
pip install -r requirements.txt
# Put your boundary file at sample_boundary.kml, or change KML_FILE in cluster_generator.py
python cluster_generator.py
```
This writes `clusters_output.json` and a preview image `clusters_preview.png`.

### 4. Run Backend
```bash
pip install fastapi uvicorn
# Optional: put DB_NAME, DB_USER, DB_PASSWORD, DB_HOST, DB_PORT in a .env file
uvicorn main:app --reload
# API runs at http://localhost:8000 (interactive docs at /docs)
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/find-zone` | Given lat/lng, returns which cluster zone it falls in |
| `POST` | `/api/service-request` | Submit a field request with GPS + status |
| `DELETE` | `/api/service-request/{id}` | Delete a request |
| `GET` | `/api/zone-demand-map/{region}` | Cluster polygons + live demand counts |
| `GET` | `/api/region-boundary/{region}` | Outer boundary polygon of a region |
| `GET` | `/api/search-regions/{query}` | Search available regions |
