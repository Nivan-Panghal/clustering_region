"""
seed_db.py
──────────
Loads the zones written by cluster_generator.py into the region_clusters table
(and, optionally, adds the region to the search_regions table).

Usage:
    python seed_db.py --input clusters_output.json --region "Sample Region"
    python seed_db.py --input clusters_output.json --region "Sample Region" \
                      --state Haryana --district Rohtak --replace

Reads the same DB_* settings as the API (environment variables or a .env file).
"""

import argparse
import json
import os
import sys

import psycopg2
from dotenv import load_dotenv
from shapely.geometry import Polygon


def to_polygon_wkt(coords):
    geom = Polygon(coords)
    if not geom.is_valid:
        geom = geom.buffer(0)                      # repairs small self-intersections
    if geom.geom_type == "MultiPolygon":
        geom = max(geom.geoms, key=lambda g: g.area)
    return geom.wkt


def main():
    parser = argparse.ArgumentParser(description="Load cluster zones into PostGIS.")
    parser.add_argument("--input", default="clusters_output.json")
    parser.add_argument("--region", required=True, help="region name stored with every zone")
    parser.add_argument("--prefix", default="Zone", help='zone names are "<prefix> <number>"')
    parser.add_argument("--state", help="with --district: also add the region to search_regions")
    parser.add_argument("--district")
    parser.add_argument("--replace", action="store_true",
                        help="delete the existing zones of this region first")
    args = parser.parse_args()

    if bool(args.state) != bool(args.district):
        sys.exit("--state and --district go together.")

    load_dotenv()
    if "DB_PASSWORD" not in os.environ:
        sys.exit("DB_PASSWORD is not set. Put it in the environment or in a .env file (see .env.example).")

    with open(args.input) as f:
        zones = json.load(f)
    if not zones:
        sys.exit(f"{args.input} contains no zones.")

    conn = psycopg2.connect(
        dbname=os.getenv("DB_NAME", "geodemand"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.environ["DB_PASSWORD"],
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
    )
    try:
        with conn, conn.cursor() as cur:               # one transaction: all or nothing
            cur.execute("SELECT COUNT(*) FROM region_clusters WHERE LOWER(region_name) = LOWER(%s)",
                        (args.region,))
            existing = cur.fetchone()[0]
            if existing and not args.replace:
                sys.exit(f'Region "{args.region}" already has {existing} zones. Use --replace to overwrite.')
            if existing:
                cur.execute("DELETE FROM region_clusters WHERE LOWER(region_name) = LOWER(%s)", (args.region,))

            for zone in sorted(zones, key=lambda z: z["cluster_id"]):
                cur.execute(
                    "INSERT INTO region_clusters (region_name, cluster_name, geom) "
                    "VALUES (%s, %s, ST_GeomFromText(%s, 4326))",
                    (args.region, f"{args.prefix} {zone['cluster_id'] + 1}", to_polygon_wkt(zone["coordinates"])),
                )

            if args.state:
                cur.execute(
                    "SELECT 1 FROM search_regions WHERE state_name = %s AND district_name = %s AND region_name = %s",
                    (args.state, args.district, args.region),
                )
                if cur.fetchone() is None:
                    cur.execute(
                        "INSERT INTO search_regions (state_name, district_name, region_name) VALUES (%s, %s, %s)",
                        (args.state, args.district, args.region),
                    )
        print(f'Loaded {len(zones)} zones for region "{args.region}".')
    finally:
        conn.close()


if __name__ == "__main__":
    main()
