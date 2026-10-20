import pytest
from shapely.geometry import Polygon

from cluster_generator import build_clusters, parse_kml_boundary


@pytest.fixture(scope="module")
def result():
    coords = parse_kml_boundary("sample_boundary.kml")
    output, region, clusters = build_clusters(coords, n_clusters=6, n_samples=1500, seed=1)
    return coords, output, clusters


def test_sample_kml_parses_to_a_closed_ring():
    coords = parse_kml_boundary("sample_boundary.kml")
    assert len(coords) >= 4 and coords[0] == coords[-1]


def test_zones_never_overlap_and_cover_the_region(result):
    coords, output, clusters = result
    assert len(output) == 6
    geoms = list(clusters.geometry)
    region_area = Polygon(coords).area
    assert sum(g.area for g in geoms) == pytest.approx(region_area, rel=1e-3)   # no gaps, no double counting
    for i in range(len(geoms)):
        for j in range(i + 1, len(geoms)):
            assert geoms[i].intersection(geoms[j]).area < region_area * 1e-6


def test_output_format(result):
    _, output, _ = result
    assert sorted(z["cluster_id"] for z in output) == list(range(6))
    for zone in output:
        ring = zone["coordinates"]
        assert ring[0] == ring[-1] and all(len(p) == 2 for p in ring)


def test_same_seed_gives_same_zones():
    coords = parse_kml_boundary("sample_boundary.kml")
    a, _, _ = build_clusters(coords, 4, 800, seed=7)
    b, _, _ = build_clusters(coords, 4, 800, seed=7)
    assert a == b


def test_bad_kml_gives_a_clear_error(tmp_path):
    bad = tmp_path / "bad.kml"
    bad.write_text('<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>')
    with pytest.raises(SystemExit):
        parse_kml_boundary(str(bad))
