"""
main.py — GeoViz FastAPI Backend

Configuration comes from environment variables (or a .env file, see .env.example):
    DB_NAME, DB_USER, DB_PASSWORD (required), DB_HOST, DB_PORT
    CORS_ORIGINS   comma-separated list of browser origins allowed to call the API
    API_HOST, API_PORT, API_RELOAD
"""

import logging
import os
import re
from contextlib import contextmanager
from typing import Literal

import psycopg2
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="GeoViz API",
    description="Geospatial demand visualization — cluster zones + live field requests",
    version="1.0.0",
)

# Only the origins listed in CORS_ORIGINS can call the API from a browser. Credentials (cookies) are not used.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

if "DB_PASSWORD" not in os.environ:
    raise RuntimeError(
        "DB_PASSWORD is not set. Put it in the environment or in a .env file (see .env.example)."
    )

DB_CONFIG = {
    "dbname":   os.getenv("DB_NAME", "geodemand"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.environ["DB_PASSWORD"],
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     os.getenv("DB_PORT", "5432"),
}


@contextmanager
def db_cursor(commit: bool = False):
    """Open a connection and yield a dict cursor. Database errors become a generic 500 response;
    the details go to the server log only, never to the client."""
    conn = None
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur
        if commit:
            conn.commit()
    except HTTPException:
        raise
    except Exception:
        logger.exception("database error")
        if conn:
            conn.rollback()
        raise HTTPException(status_code=500, detail="Internal server error")
    finally:
        if conn:
            conn.close()


# ── Models ────────────────────────────────────────────────────────────────────

NAME = Field(min_length=1, max_length=100)


class LocationRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class ServiceRequest(BaseModel):
    # request_id acts as the owner's secret: only the client that created it knows it, and it is
    # never returned by the API. Clients generate it randomly, e.g. a UUID4 (36 characters).
    request_id:   str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    region_name:  str = NAME
    cluster_name: str = NAME
    status_level: Literal["low", "medium", "high", "full"]
    latitude:     float = Field(ge=-90, le=90)
    longitude:    float = Field(ge=-180, le=180)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def root():
    return {"status": "ok", "service": "GeoViz API"}


# ── Zone detection ────────────────────────────────────────────────────────────

@app.post("/api/find-zone", tags=["Zones"])
def find_zone(data: LocationRequest):
    """Given a GPS coordinate, returns which cluster zone it falls inside."""
    with db_cursor() as cur:
        cur.execute("""
            SELECT region_name, cluster_name
            FROM region_clusters
            WHERE ST_Contains(geom, ST_SetSRID(ST_Point(%s, %s), 4326))
            LIMIT 1;
        """, (data.lng, data.lat))
        row = cur.fetchone()
    if row:
        return {"region": row["region_name"], "cluster": row["cluster_name"]}
    return {"region": None, "cluster": None}


# ── Service requests ──────────────────────────────────────────────────────────

@app.post("/api/service-request", tags=["Requests"])
def create_service_request(data: ServiceRequest):
    """Submit a field request. One active request per request_id — a new one replaces the old."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            "SELECT 1 FROM region_clusters WHERE region_name = %s AND cluster_name = %s LIMIT 1",
            (data.region_name, data.cluster_name),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=422, detail="Unknown region or cluster")
        cur.execute("""
            INSERT INTO service_requests
                (request_id, region_name, cluster_name, status_level, latitude, longitude, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (request_id) DO UPDATE SET
                region_name  = EXCLUDED.region_name,
                cluster_name = EXCLUDED.cluster_name,
                status_level = EXCLUDED.status_level,
                latitude     = EXCLUDED.latitude,
                longitude    = EXCLUDED.longitude,
                created_at   = EXCLUDED.created_at
        """, (
            data.request_id, data.region_name, data.cluster_name,
            data.status_level, data.latitude, data.longitude,
        ))
    return {"message": "Request submitted"}


@app.delete("/api/service-request/{request_id}", tags=["Requests"])
def delete_service_request(
    request_id: str = Path(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
):
    """Delete a previously submitted request. Only whoever knows its request_id can do this."""
    with db_cursor(commit=True) as cur:
        cur.execute("DELETE FROM service_requests WHERE request_id = %s", (request_id,))
        deleted = cur.rowcount
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Request not found")
    return {"message": "Request deleted"}


# ── Demand map data ───────────────────────────────────────────────────────────

@app.get("/api/zone-demand-map/{region_name}", tags=["Map"])
def get_zone_demand_map(region_name: str = Path(min_length=1, max_length=100)):
    """
    Returns all cluster polygons for a region with live demand data.
    Each cluster includes: polygon coordinates, demand count, urgency score, color.
    Pins carry location and status only; request IDs are never exposed.
    """
    with db_cursor() as cur:
        # Cluster polygons via PostGIS → GeoJSON coordinates
        cur.execute("""
            SELECT
                id,
                cluster_name,
                ST_AsGeoJSON(geom)::json -> 'coordinates' AS coordinates,
                ST_X(ST_Centroid(geom)) AS center_lng,
                ST_Y(ST_Centroid(geom)) AS center_lat
            FROM region_clusters
            WHERE LOWER(region_name) = LOWER(%s)
            ORDER BY id
        """, (region_name,))
        clusters = cur.fetchall()

        if not clusters:
            raise HTTPException(status_code=404, detail="No clusters found for this region")

        # Live demand aggregated per cluster
        cur.execute("""
            SELECT
                LOWER(cluster_name)  AS cluster_key,
                COUNT(*)             AS demand_count,
                MAX(CASE
                    WHEN status_level = 'full'   THEN 4
                    WHEN status_level = 'high'   THEN 3
                    WHEN status_level = 'medium' THEN 2
                    WHEN status_level = 'low'    THEN 1
                    ELSE 0
                END)                 AS urgency_score,
                JSON_AGG(JSON_BUILD_OBJECT(
                    'lat',          latitude,
                    'lng',          longitude,
                    'status_level', status_level,
                    'has_gps',      (latitude IS NOT NULL AND longitude IS NOT NULL)
                )) AS pins
            FROM service_requests
            WHERE LOWER(region_name) = LOWER(%s)
            GROUP BY LOWER(cluster_name)
        """, (region_name,))
        demand_map = {
            row["cluster_key"]: {
                "demand_count":  row["demand_count"],
                "urgency_score": row["urgency_score"],
                "pins":          row["pins"] or [],
            }
            for row in cur.fetchall()
        }

    max_demand = max((v["demand_count"] for v in demand_map.values()), default=1)

    result = []
    for c in clusters:
        info = demand_map.get(c["cluster_name"].lower(),
                              {"demand_count": 0, "urgency_score": 0, "pins": []})
        count   = info["demand_count"]
        urgency = info["urgency_score"]
        ratio   = count / max_demand if max_demand > 0 else 0
        coords  = c["coordinates"][0] if c["coordinates"] else []

        result.append({
            "cluster_id":    c["id"],
            "cluster_name":  c["cluster_name"],
            "coordinates":   coords,
            "center_lat":    c["center_lat"],
            "center_lng":    c["center_lng"],
            "demand_count":  count,
            "urgency_score": urgency,
            "color":         _color(ratio, urgency),
            "opacity":       0.22 if count == 0 else min(0.35 + ratio * 0.45, 0.85),
            "pins":          info["pins"],
        })

    return {
        "region":         region_name,
        "clusters":       result,
        "total_requests": sum(v["demand_count"] for v in demand_map.values()),
        "max_demand":     max_demand,
    }


@app.get("/api/region-boundary/{region_name}", tags=["Map"])
def get_region_boundary(region_name: str = Path(min_length=1, max_length=100)):
    """Returns outer boundary polygon by unioning all cluster geometries."""
    with db_cursor() as cur:
        cur.execute("""
            SELECT
                ST_AsGeoJSON(ST_Union(geom))::json -> 'coordinates' AS coordinates,
                ST_X(ST_Centroid(ST_Union(geom))) AS center_lng,
                ST_Y(ST_Centroid(ST_Union(geom))) AS center_lat
            FROM region_clusters
            WHERE LOWER(region_name) = LOWER(%s)
        """, (region_name,))
        row = cur.fetchone()
    if not row or not row["coordinates"]:
        return {"region": region_name, "coordinates": [], "center": None}

    raw = row["coordinates"]
    outer = max(raw, key=lambda p: len(p[0]))[0] if isinstance(raw[0][0][0], list) else raw[0]
    return {
        "region":      region_name,
        "coordinates": outer,
        "center":      {"lat": row["center_lat"], "lng": row["center_lng"]},
    }


@app.get("/api/search-regions/{query}", tags=["Search"])
def search_regions(query: str = Path(min_length=1, max_length=100)):
    """Search across state, district, and region names."""
    pattern = "%" + re.sub(r"([\\%_])", r"\\\1", query) + "%"   # treat the query as plain text
    with db_cursor() as cur:
        cur.execute("""
            SELECT state_name, district_name, region_name
            FROM search_regions
            WHERE LOWER(full_name) LIKE LOWER(%s) ESCAPE '\\'
            LIMIT 20
        """, (pattern,))
        return cur.fetchall()


# ── Color helper ──────────────────────────────────────────────────────────────

def _color(ratio: float, urgency: int) -> str:
    if urgency == 4:   return "#C62828"
    if urgency == 3:   return "#E64A19"
    if ratio == 0:     return "#388E3C"
    if ratio < 0.25:   return "#66BB6A"
    if ratio < 0.5:    return "#FDD835"
    if ratio < 0.75:   return "#FB8C00"
    return "#E53935"


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("API_HOST", "127.0.0.1"),       # 127.0.0.1 unless API_HOST is set; 0.0.0.0 exposes every interface
        port=int(os.getenv("API_PORT", 8000)),
        reload=os.getenv("API_RELOAD", "false").lower() == "true",
    )
