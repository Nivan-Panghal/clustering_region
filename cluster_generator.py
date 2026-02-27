"""
cluster_generator.py
────────────────────
Generates K-Means cluster zones from a KML boundary file of a region.
You can create a KML boundary using tools like Google Earth or QGIS by tracing the outline of a region.


Usage:
    python cluster_generator.py

Outputs:
    clusters_output.json   — JSON file with cluster_id and coordinates for each zone polygon.
"""

import xml.etree.ElementTree as ET
import numpy as np
import json
import geopandas as gpd
from shapely.geometry import Polygon, Point
from sklearn.cluster import KMeans

# ============================================================
# CONFIGURATION — adjust these for your region
# ============================================================

KML_FILE = "sample_boundary.kml"       # path to your KML boundary file
OUTPUT_FILE = "clusters_output.json"   # output JSON path

# Number of clusters — tune based on:
#   - Physical size of the region (larger area → more clusters)
#   - Density of demand expected (higher density → more clusters)
#   - How granular you want zone assignments to be
#   Rule of thumb: 1 cluster per ~0.5–1 hectare works well for dense areas
N_CLUSTERS = 40

# Number of random interior points to sample before clustering.
# More points = more accurate cluster shapes, but slower.
# 20,000 is a good balance for regions up to ~5 km²
N_SAMPLE_POINTS = 20000

# Buffer radius in meters applied around each cluster centroid
# before dissolving into polygons.
# Smaller = tighter clusters with gaps between them
# Larger  = overlapping zones (the intersection clip handles overlap)
# Adjust based on average zone size you want on the map
BUFFER_METERS = 40

# ============================================================
# STEP 1: Parse KML boundary
# ============================================================

print(f"Parsing KML: {KML_FILE}")
tree = ET.parse(KML_FILE)
root = tree.getroot()
namespace = {"kml": "http://www.opengis.net/kml/2.2"}
# Extract the text content inside the <coordinates> tag from the KML file
coords_text = root.find(".//kml:coordinates", namespace).text.strip()

boundary_coords = []
for coord in coords_text.split():
    lon, lat, *_ = map(float, coord.split(","))
    boundary_coords.append((lon, lat))

print(f"  Boundary points: {len(boundary_coords)}")

boundary_polygon = Polygon(boundary_coords)
region = gpd.GeoDataFrame(geometry=[boundary_polygon], crs="EPSG:4326")

# ============================================================
# STEP 2: Project to UTM for metric distance calculations
#
# K-Means uses Euclidean distance. Raw lat/lng degrees are NOT
# equal in meters — 1° longitude ≠ 1° latitude in real distance.
# UTM projection gives true metric coordinates so all cluster
# distances are geographically accurate and equal-area.
# ============================================================

mean_lon = np.mean([c[0] for c in boundary_coords])
utm_zone = int((mean_lon + 180) / 6) + 1
epsg_code = 32600 + utm_zone
print(f"  Auto-detected UTM zone: {utm_zone} (EPSG:{epsg_code})")

region_utm = region.to_crs(epsg=epsg_code)

# ============================================================
# STEP 3: Sample random points inside boundary (in meters)
# ============================================================

minx, miny, maxx, maxy = region_utm.total_bounds

print(f"Sampling {N_SAMPLE_POINTS} interior points...")
points = []
while len(points) < N_SAMPLE_POINTS:
    p = Point(
        np.random.uniform(minx, maxx),
        np.random.uniform(miny, maxy),
    )
    if region_utm.contains(p).any():
        points.append([p.x, p.y])

points = np.array(points)
print(f"  Done — {len(points)} points sampled")

# ============================================================
# STEP 4: K-Means clustering in metric space (meters)
#
# n_init=20 runs 20 independent initializations and picks the
# best result — reduces risk of poor cluster placement.
# ============================================================

print(f"Running K-Means: {N_CLUSTERS} clusters, n_init=20...")
kmeans = KMeans(n_clusters=N_CLUSTERS, random_state=42, n_init=20)
kmeans.fit(points)

points_gdf = gpd.GeoDataFrame(
    geometry=[Point(xy) for xy in points],
    crs=f"EPSG:{epsg_code}",
)
points_gdf["cluster_id"] = kmeans.labels_
print(f"  Unique clusters created: {points_gdf['cluster_id'].nunique()}")

# ============================================================
# STEP 5: Buffer points → dissolve into polygon zones
#
# Buffer radius controls zone size on the map.
# Larger buffer = more visible zones but may overlap more.
# The overlay clip below handles any boundary overflow.
# ============================================================

print(f"Buffering by {BUFFER_METERS}m and dissolving into polygons...")
points_gdf["geometry"] = points_gdf.buffer(BUFFER_METERS)
clusters = points_gdf.dissolve(by="cluster_id")

# Clip to original boundary — removes anything outside the region
clusters = gpd.overlay(clusters, region_utm, how="intersection")
print(f"  Polygons after boundary clip: {len(clusters)}")

# ============================================================
# STEP 6: Validate cluster count
# ============================================================

if len(clusters) != N_CLUSTERS:
    print(f"  WARNING: expected {N_CLUSTERS} clusters, got {len(clusters)}")
    print("  This can happen if some clusters were entirely outside the boundary.")
    print("  Consider increasing N_SAMPLE_POINTS or decreasing BUFFER_METERS.")

# ============================================================
# STEP 7: Reproject back to WGS84 (lat/lng) 
# ============================================================

clusters = clusters.to_crs(epsg=4326)

# ============================================================
# STEP 8: Export as JSON
#
# Output format: [{cluster_id, coordinates: [[lon, lat], ...]}]

# ============================================================

output = []
for idx, row in clusters.iterrows():
    geom = row.geometry
    # If dissolve produced a MultiPolygon, keep only the largest part
    if geom.geom_type == "MultiPolygon":
        geom = max(geom.geoms, key=lambda p: p.area)
    coords = list(geom.exterior.coords)
    output.append({
        "cluster_id":  int(idx),
        "coordinates": coords,
    })

with open(OUTPUT_FILE, "w") as f:
    json.dump(output, f, indent=4)

print(f"\n✅ {OUTPUT_FILE} saved — {len(output)} clusters")
print("Next step: run  python seed_db.py --input", OUTPUT_FILE, '--region "Your Region Name"')

# ============================================================
# STEP 9: Visualize clusters (optional — comment out to skip)
# ============================================================

import matplotlib.pyplot as plt

clusters_plot  = clusters.to_crs(epsg=4326)
boundary_plot  = region.to_crs(epsg=4326)      # original WGS84 boundary

fig, ax = plt.subplots(figsize=(12, 12))

# Village / region boundary outline
boundary_plot.boundary.plot(ax=ax, linewidth=2, color="black")

# Cluster polygons — each cluster gets a distinct color
clusters_plot.plot(
    ax=ax,
    column=clusters_plot.index,
    cmap="tab20",
    alpha=0.5,
    edgecolor="black",
    linewidth=0.6,
)

# Cluster centroids
centroids     = clusters_plot.centroid
centroids_gdf = gpd.GeoDataFrame(geometry=centroids, crs="EPSG:4326")
centroids_gdf.plot(ax=ax, markersize=15, color="navy", zorder=5)

# Cluster ID labels
for idx, point in enumerate(centroids):
    ax.text(point.x, point.y, str(idx), fontsize=7, ha="center", va="center", color="white", fontweight="bold")

ax.set_title(f"Region Clusters — {N_CLUSTERS} zones", fontsize=16)
ax.set_xlabel("Longitude")
ax.set_ylabel("Latitude")
ax.set_aspect("equal")
plt.tight_layout()
plt.savefig("clusters_preview.png", dpi=150, bbox_inches="tight")
plt.show()
print("📊 Preview saved to clusters_preview.png")