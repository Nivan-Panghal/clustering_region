"""
cluster_generator.py
────────────────────
Generates K-Means cluster zones from a KML boundary file of a region.
A KML boundary can be created with Google Earth or QGIS by tracing the outline of a region.

Usage:
    python cluster_generator.py                                  # uses sample_boundary.kml
    python cluster_generator.py --kml my_village.kml --clusters 25 --out my_clusters.json

Outputs:
    clusters_output.json   — [{"cluster_id": int, "coordinates": [[lon, lat], ...]}, ...]
    clusters_preview.png   — picture of the zones (skip with --no-preview)

Tuning:
    --clusters   number of zones. Larger area or higher expected demand → more zones.
    --samples    random interior points to cluster. More points = smoother zone shapes but slower.
                 20,000 is a good balance for regions up to ~5 km².

Zones are the areas closest to each K-Means center, clipped to the boundary, so they never overlap.
"""

import argparse
import json
import xml.etree.ElementTree as ET

import geopandas as gpd
import numpy as np
import shapely
from shapely.geometry import Point, Polygon
from sklearn.cluster import KMeans

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


def parse_kml_boundary(path):
    """Return the first polygon ring in the KML file as a list of (lon, lat)."""
    root = ET.parse(path).getroot()
    node = root.find(".//kml:coordinates", KML_NS)
    if node is None or not node.text or not node.text.strip():
        raise SystemExit(f"No <coordinates> found in {path}. Is this a KML file with a polygon?")
    coords = []
    for item in node.text.split():
        lon, lat, *_ = map(float, item.split(","))
        coords.append((lon, lat))
    if len(coords) < 4:
        raise SystemExit(f"{path}: a polygon needs at least 4 coordinate points, found {len(coords)}.")
    return coords


def sample_points_in(polygon, n, rng):
    """Uniform random points inside a (metric) polygon."""
    minx, miny, maxx, maxy = polygon.bounds
    kept = np.empty((0, 2))
    while len(kept) < n:
        xs = rng.uniform(minx, maxx, n)
        ys = rng.uniform(miny, maxy, n)
        inside = shapely.contains_xy(polygon, xs, ys)
        kept = np.vstack([kept, np.column_stack([xs[inside], ys[inside]])])
    return kept[:n]


def build_clusters(boundary_coords, n_clusters=40, n_samples=20000, seed=42):
    """KML boundary → list of {"cluster_id", "coordinates"} plus the GeoDataFrames used for plotting."""
    if n_clusters > n_samples:
        raise SystemExit("--clusters cannot be larger than --samples.")

    region = gpd.GeoDataFrame(geometry=[Polygon(boundary_coords)], crs="EPSG:4326")

    # K-Means uses Euclidean distance, and degrees of longitude and latitude are not the same length
    # in meters. So we project to UTM, where one unit is one meter, before sampling and clustering.
    mean_lon = np.mean([c[0] for c in boundary_coords])
    utm_zone = int((mean_lon + 180) / 6) + 1
    epsg_code = (32600 if np.mean([c[1] for c in boundary_coords]) >= 0 else 32700) + utm_zone
    region_utm = region.to_crs(epsg=epsg_code)

    rng = np.random.default_rng(seed)
    points = sample_points_in(region_utm.geometry.iloc[0], n_samples, rng)

    # n_init=20 runs 20 independent starts and keeps the best, which avoids poor cluster placement.
    kmeans = KMeans(n_clusters=n_clusters, random_state=seed, n_init=20).fit(points)

    # Every sampled point belongs to its nearest cluster center, so each zone is exactly the area
    # closer to its center than to any other center (a Voronoi cell), clipped to the boundary.
    # Zones therefore cover the whole region with no gaps and no overlaps, which find-zone needs:
    # a GPS point must fall in exactly one zone.
    region_geom = region_utm.geometry.iloc[0]
    centers = [Point(xy) for xy in kmeans.cluster_centers_]
    cells = list(shapely.voronoi_polygons(shapely.MultiPoint(centers), extend_to=region_geom).geoms)
    rows = []
    for cluster_id, center in enumerate(centers):
        cell = next(c for c in cells if c.contains(center))
        rows.append({"cluster_id": cluster_id, "geometry": cell.intersection(region_geom)})
    clusters = gpd.GeoDataFrame(rows, crs=f"EPSG:{epsg_code}")
    clusters = clusters[~clusters.geometry.is_empty].to_crs(epsg=4326)

    output = []
    for _, row in clusters.iterrows():
        geom = row.geometry
        if geom.geom_type == "MultiPolygon":          # keep only the largest part
            geom = max(geom.geoms, key=lambda p: p.area)
        output.append({
            "cluster_id":  int(row["cluster_id"]),
            "coordinates": [list(c) for c in geom.exterior.coords],
        })
    return output, region, clusters


def save_preview(region, clusters, path, show=False):
    import matplotlib
    if not show:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 12))
    region.boundary.plot(ax=ax, linewidth=2, color="black")
    clusters.plot(ax=ax, column="cluster_id", cmap="tab20", alpha=0.5, edgecolor="black", linewidth=0.6)
    for _, row in clusters.iterrows():
        c = row.geometry.centroid
        ax.plot(c.x, c.y, "o", markersize=4, color="navy", zorder=5)
        ax.text(c.x, c.y, str(row["cluster_id"]), fontsize=7, ha="center", va="center",
                color="white", fontweight="bold")
    ax.set_title(f"Region clusters — {len(clusters)} zones", fontsize=16)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.set_aspect("equal")
    plt.tight_layout()
    plt.savefig(path, dpi=150, bbox_inches="tight")
    if show:
        plt.show()
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description="Divide a KML region into K-Means cluster zones.")
    parser.add_argument("--kml", default="sample_boundary.kml", help="KML file with the region boundary")
    parser.add_argument("--out", default="clusters_output.json", help="where to write the JSON")
    parser.add_argument("--clusters", type=int, default=40)
    parser.add_argument("--samples", type=int, default=20000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--preview", default="clusters_preview.png", help="preview image path")
    parser.add_argument("--no-preview", action="store_true")
    parser.add_argument("--show", action="store_true", help="also open the preview in a window")
    args = parser.parse_args()

    print(f"Parsing KML: {args.kml}")
    coords = parse_kml_boundary(args.kml)
    print(f"  Boundary points: {len(coords)}")

    print(f"Sampling {args.samples} points and running K-Means ({args.clusters} clusters)...")
    output, region, clusters = build_clusters(coords, args.clusters, args.samples, args.seed)
    if len(output) != args.clusters:
        print(f"  WARNING: expected {args.clusters} clusters, got {len(output)}.")
        print("  Some zones came out empty (too few --samples, or too many --clusters for this region).")

    with open(args.out, "w") as f:
        json.dump(output, f, indent=4)
    print(f"Saved {args.out} with {len(output)} clusters")
    print(f'Next step: python seed_db.py --input {args.out} --region "Your Region Name"')

    if not args.no_preview:
        save_preview(region, clusters, args.preview, show=args.show)
        print(f"Preview saved to {args.preview}")


if __name__ == "__main__":
    main()
