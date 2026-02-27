-- ============================================================
-- GeoViz — Database Schema
-- Requires PostgreSQL 14+ with PostGIS extension
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- Cluster polygons per region 
CREATE TABLE IF NOT EXISTS region_clusters (
    id           SERIAL PRIMARY KEY,
    region_name  TEXT    NOT NULL,
    cluster_name TEXT    NOT NULL,
    geom         geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_region_clusters_geom   ON region_clusters USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_region_clusters_region ON region_clusters (region_name);

-- Field requests submitted by app users
CREATE TABLE IF NOT EXISTS service_requests (
    id           SERIAL PRIMARY KEY,
    request_id   TEXT    NOT NULL UNIQUE,
    region_name  TEXT    NOT NULL,
    cluster_name TEXT    NOT NULL,
    status_level TEXT    NOT NULL,   -- low / medium / high / full
    latitude     DOUBLE PRECISION,
    longitude    DOUBLE PRECISION,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_service_requests_region  ON service_requests (region_name);
CREATE INDEX IF NOT EXISTS idx_service_requests_cluster ON service_requests (cluster_name);

-- Region search lookup table
CREATE TABLE IF NOT EXISTS search_regions (
    id            SERIAL PRIMARY KEY,
    state_name    VARCHAR(100) NOT NULL,
    district_name VARCHAR(100) NOT NULL,
    region_name   VARCHAR(100) NOT NULL,
    full_name     TEXT GENERATED ALWAYS AS (
                    state_name || ' , ' || district_name || ' , ' || region_name
                  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_search_regions_fulltext
    ON search_regions USING GIN (to_tsvector('simple', full_name));