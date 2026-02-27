# GeoViz — Geospatial Demand Visualization Platform

A full-stack geospatial platform that divides a geographic region into demand clusters using **K-Means clustering on KML boundary data**, collects live field requests via a **React Native Expo mobile app**, and visualizes real-time demand intensity on  **Leaflet.js map**. 

Kml file contains the boudary coordinates(latitude & logitude) of the region and we create random interior latitude and logitude points, and on the basis of those points we create cluster using euclidian distance and after that it returns json file with cluster boundary coordinates , as user sumit location our app makes request to FastAPI backend performs a spatial query to determine which cluster polygon contains the coordinates and returns the corresponding service area
You can create a KML boundary using tools like Google Earth or QGIS by tracing the outline of a region Or get from ISRO bhuvan site.


---

## What It Does

1. **Boundary Ingestion** — Parses a KML file defining a region's geographic boundary
2. **Cluster Generation** — Runs K-Means (scikit-learn) on sampled points inside the boundary to divide it into N service zones
3. **PostGIS Storage** — Stores cluster polygons as PostGIS geometry for fast spatial queries
4. **Field Data Collection** — Mobile app users submit geo-tagged service requests from the field
5. **Live Demand Map** — A worker-facing map colors each cluster zone by request intensity (green → red)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile App | React Native (Expo) |
| Backend API | FastAPI (Python) |
| Database | PostgreSQL + PostGIS |
| Spatial Clustering | scikit-learn K-Means + GeoPandas |
| Map Rendering | Leaflet.js (WebView / iframe) |


---

## Project Structure

```
Clustering_region/
│
├── cluster_generator.py      # KML → K-Means → 
├── main.py                   # FastAPI backend
├── requirements.txt
├── Schema.sql                # Database schema + 
├── README.md
├── .gitignore
│
└── mobile/
    └── cluster_app/
        ├── app/
        │   ├── _layout.jsx
        │   ├── index.jsx
        │   ├── MapScreen.jsx
        │   └── RequestService.jsx
        │
        ├── components/
        ├── theme/
        │   ├── colors.jsx
        │   └── ThemeContext.jsx
        │
        ├── app.json
        ├── package.json
        └── tsconfig.json


```

---

## Setup & Run

### 1. Prerequisites
- Python 3.10+
- Node.js 18+
- PostgreSQL 14+ with PostGIS extension
- Expo CLI

### 2. Database Setup
```bash
# Create database and enable PostGIS
psql -U postgres -c "CREATE DATABASE geodemand;"
psql -U postgres -d geodemand -c "CREATE EXTENSION postgis;"

# Run schema
psql -U postgres -d geodemand -f backend/schema.sql
```

### 3. Generate Clusters from KML
```bash

pip install -r requirements.txt
python cluster_generator.py 
```

### 4. Run Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
# API runs at http://localhost:8000

```

### 5. Run Mobile App
```bash
cd mobile/cluster_app
npm install
npx expo start
# Press w for web, a for Android
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


