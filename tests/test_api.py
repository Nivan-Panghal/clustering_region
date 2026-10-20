"""API tests. The first group needs no database. The second group needs a PostGIS database
reachable with the DB_* settings (see .env.example) and is skipped when none is available."""

import uuid

import psycopg2
import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app, raise_server_exceptions=False)
RID = "a" * 20


# ── No database needed ───────────────────────────────────────────────────────

def test_health():
    assert client.get("/").json()["status"] == "ok"


@pytest.mark.parametrize("body", [{"lat": 91, "lng": 0}, {"lat": 0, "lng": 181}, {"lat": "x", "lng": 0}])
def test_find_zone_rejects_bad_coordinates(body):
    assert client.post("/api/find-zone", json=body).status_code == 422


@pytest.mark.parametrize("change", [
    {"status_level": "urgent"},
    {"request_id": "short"},
    {"request_id": "has spaces and ../ chars!!"},
    {"latitude": 200},
    {"region_name": ""},
])
def test_service_request_rejects_bad_input(change):
    body = {"request_id": RID, "region_name": "R", "cluster_name": "Zone 1",
            "status_level": "low", "latitude": 28.9, "longitude": 76.6, **change}
    assert client.post("/api/service-request", json=body).status_code == 422


def test_delete_rejects_malformed_id():
    assert client.delete("/api/service-request/short").status_code == 422


def test_cors_only_allows_listed_origins():
    ok = client.options("/api/find-zone", headers={
        "Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    bad = client.options("/api/find-zone", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert "access-control-allow-origin" not in bad.headers
    assert "access-control-allow-credentials" not in ok.headers


def test_database_errors_do_not_leak_details(monkeypatch):
    monkeypatch.setitem(main.DB_CONFIG, "port", "1")            # nothing listens there
    monkeypatch.setitem(main.DB_CONFIG, "host", "db.internal.example")
    response = client.post("/api/find-zone", json={"lat": 1, "lng": 1})
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}
    assert "db.internal" not in response.text and "psycopg2" not in response.text


# ── Needs a PostGIS database ─────────────────────────────────────────────────

@pytest.fixture()
def region():
    try:
        conn = psycopg2.connect(**main.DB_CONFIG)
    except psycopg2.OperationalError:
        pytest.skip("no PostGIS database reachable with the DB_* settings")
    name = f"pytest-{uuid.uuid4().hex[:8]}"
    with conn, conn.cursor() as cur:
        for zone, (x0, x1) in (("Zone 1", (0, 1)), ("Zone 2", (1, 2))):
            cur.execute(
                "INSERT INTO region_clusters (region_name, cluster_name, geom) "
                "VALUES (%s, %s, ST_MakeEnvelope(%s, 0, %s, 1, 4326))", (name, zone, x0, x1))
        cur.execute("INSERT INTO search_regions (state_name, district_name, region_name) "
                    "VALUES ('S', 'D', %s)", (name,))
    yield name
    with conn, conn.cursor() as cur:
        cur.execute("DELETE FROM service_requests WHERE region_name = %s", (name,))
        cur.execute("DELETE FROM region_clusters WHERE region_name = %s", (name,))
        cur.execute("DELETE FROM search_regions WHERE region_name = %s", (name,))
    conn.close()


def request_body(region, rid=RID, zone="Zone 1", level="medium", lat=0.5, lng=0.5):
    return {"request_id": rid, "region_name": region, "cluster_name": zone,
            "status_level": level, "latitude": lat, "longitude": lng}


def test_find_zone(region):
    assert client.post("/api/find-zone", json={"lat": 0.5, "lng": 0.5}).json()["cluster"] == "Zone 1"
    assert client.post("/api/find-zone", json={"lat": 0.5, "lng": 1.5}).json()["cluster"] == "Zone 2"
    assert client.post("/api/find-zone", json={"lat": 50, "lng": 50}).json() == {"region": None, "cluster": None}


def test_request_lifecycle_and_privacy(region):
    assert client.post("/api/service-request", json=request_body(region)).status_code == 200
    data = client.get(f"/api/zone-demand-map/{region}").json()
    assert data["total_requests"] == 1
    zone1 = next(c for c in data["clusters"] if c["cluster_name"] == "Zone 1")
    assert zone1["demand_count"] == 1 and len(zone1["pins"]) == 1
    assert RID not in client.get(f"/api/zone-demand-map/{region}").text       # request ids are never exposed

    client.post("/api/service-request", json=request_body(region, level="full"))   # same id → replaced
    data = client.get(f"/api/zone-demand-map/{region}").json()
    assert data["total_requests"] == 1
    assert next(c for c in data["clusters"] if c["cluster_name"] == "Zone 1")["urgency_score"] == 4

    assert client.delete(f"/api/service-request/{RID}").status_code == 200
    assert client.delete(f"/api/service-request/{RID}").status_code == 404


def test_request_for_unknown_zone_is_rejected(region):
    assert client.post("/api/service-request", json=request_body(region, zone="Nope")).status_code == 422


def test_unknown_region_is_404(region):
    assert client.get("/api/zone-demand-map/does-not-exist-xyz").status_code == 404


def test_search_treats_wildcards_as_plain_text(region):
    assert client.get(f"/api/search-regions/{region[:12]}").json()[0]["region_name"] == region
    assert client.get("/api/search-regions/%25").json() == []      # a literal "%" must not match everything


def test_region_boundary(region):
    data = client.get(f"/api/region-boundary/{region}").json()
    assert len(data["coordinates"]) >= 4
