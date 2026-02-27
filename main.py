"""
main.py — GeoViz FastAPI Backend

"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor
import uvicorn
import logging
import os
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="GeoViz API",
    description="Geospatial demand visualization — cluster zones + live field requests",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_CONFIG = {
    "dbname":   os.getenv("DB_NAME", "geodemand"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", "password"),
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     os.getenv("DB_PORT", "5432"),
}

def get_db():
    return psycopg2.connect(**DB_CONFIG)


# ── Models ────────────────────────────────────────────────────────────────────

class LocationRequest(BaseModel):
    lat: float
    lng: float

class ServiceRequest(BaseModel):
    request_id:   str
    region_name:  str
    cluster_name: str
    status_level: str   # "low" | "medium" | "high" | "full"
    latitude:     float
    longitude:    float


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def root():
    return {"status": "ok", "service": "GeoViz API"}


# ── Zone detection ────────────────────────────────────────────────────────────

@app.post("/api/find-zone", tags=["Zones"])
def find_zone(data: LocationRequest):
    """Given a GPS coordinate, returns which cluster zone it falls inside."""
    conn = cur = None
    try:
        conn = get_db()
        cur = conn.cursor(cursor_factory=RealDictCursor)
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
    except Exception as e:
        logger.error(f"find-zone error: {e}")
        return {"error": str(e)}
    finally:
        if cur: cur.close()
        if conn: conn.close()


# ── Service requests ──────────────────────────────────────────────────────────

@app.post("/api/service-request", tags=["Requests"])
def create_service_request(data: ServiceRequest):
    """Submit a field request. One active request per user — replaces previous."""
    conn = cur = None
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("DELETE FROM service_requests WHERE request_id = %s", (data.request_id,))
        cur.execute("""
            INSERT INTO service_requests
                (request_id, region_name, cluster_name, status_level, latitude, longitude, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            data.request_id, data.region_name, data.cluster_name,
            data.status_level, data.latitude, data.longitude, datetime.now()
        ))
        conn.commit()
        return {"message": "Request submitted"}
    except Exception as e:
        logger.error(f"service-request error: {e}")
        if conn: conn.rollback()
        return {"error": str(e)}
    finally:
        if cur: cur.close()
        if conn: conn.close()


@app.delete("/api/service-request/{request_id}", tags=["Requests"])
def delete_service_request(request_id: str):
    """Delete a previously submitted request."""
    conn = cur = None
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("DELETE FROM service_requests WHERE request_id = %s", (request_id,))
        conn.commit()
        return {"message": "Request deleted"}
    except Exception as e:
        if conn: conn.rollback()
        return {"error": str(e)}
    finally:
        if cur: cur.close()
        if conn: conn.close()


# ── Demand map data ───────────────────────────────────────────────────────────

@app.get("/api/zone-demand-map/{region_name}", tags=["Map"])
def get_zone_demand_map(region_name: str):
    """
    Returns all cluster polygons for a region with live demand data.
    Each cluster includes: polygon coordinates, demand count, urgency score, color.
    """
    conn = cur = None
    try:
        conn = get_db()
        cur = conn.cursor(cursor_factory=RealDictCursor)

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
            return {"error": f"No clusters found for region: {region_name}"}

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
                    'request_id',  request_id,
                    'lat',         latitude,
                    'lng',         longitude,
                    'status_level', status_level,
                    'has_gps',     (latitude IS NOT NULL AND longitude IS NOT NULL)
                )) AS pins
            FROM service_requests
            WHERE LOWER(region_name) = LOWER(%s)
            GROUP BY LOWER(cluster_name), cluster_name
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
                "cluster_id":   c["id"],
                "cluster_name": c["cluster_name"],
                "coordinates":  coords,
                "center_lat":   c["center_lat"],
                "center_lng":   c["center_lng"],
                "demand_count": count,
                "urgency_score": urgency,
                "color":        _color(ratio, urgency),
                "opacity":      0.22 if count == 0 else min(0.35 + ratio * 0.45, 0.85),
                "pins":         info["pins"],
            })

        return {
            "region":         region_name,
            "clusters":       result,
            "total_requests": sum(v["demand_count"] for v in demand_map.values()),
            "max_demand":     max_demand,
        }

    except Exception as e:
        logger.error(f"zone-demand-map error: {e}")
        return {"error": str(e)}
    finally:
        if cur: cur.close()
        if conn: conn.close()


@app.get("/api/region-boundary/{region_name}", tags=["Map"])
def get_region_boundary(region_name: str):
    """Returns outer boundary polygon by unioning all cluster geometries."""
    conn = cur = None
    try:
        conn = get_db()
        cur = conn.cursor(cursor_factory=RealDictCursor)
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
    except Exception as e:
        logger.error(f"region-boundary error: {e}")
        return {"error": str(e)}
    finally:
        if cur: cur.close()
        if conn: conn.close()


@app.get("/api/search-regions/{query}", tags=["Search"])
def search_regions(query: str):
    """Full-text search across state, district, and region names."""
    conn = cur = None
    try:
        conn = get_db()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT state_name, district_name, region_name
            FROM search_regions
            WHERE LOWER(full_name) LIKE LOWER(%s)
            LIMIT 20
        """, (f"%{query}%",))
        return cur.fetchall()
    except Exception as e:
        return {"error": str(e)}
    finally:
        if cur: cur.close()
        if conn: conn.close()


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
        host=os.getenv("API_HOST", "0.0.0.0"),
        port=int(os.getenv("API_PORT", 8000)),
        reload=True,
    )