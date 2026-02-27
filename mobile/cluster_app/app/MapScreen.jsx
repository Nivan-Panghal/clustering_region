// MapScreen.js — Live Demand Map
// ─────────────────────────────────────────────────────────────────────────────
// Shows a Leaflet.js cluster demand map for a selected region.
//
// Regions are stored in the database (search_regions table) and fetched
// live via GET /api/search-regions/{query} as the user types.
// No regions are hardcoded here — everything comes from the database.
//
// Once a region is selected:
//   - GET /api/zone-demand-map/{region}  → cluster polygons + demand counts + pins
//   - GET /api/region-boundary/{region}  → outer boundary polygon

//
// Pins on the map represent individual service_requests rows.
// Pin color matches the requirement level submitted by each user.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Platform, ScrollView, TextInput,
} from "react-native";
import { useTheme } from "../theme/ThemeContext";
import BottomTabs from "../components/BottomTabs";

let WebView;
if (Platform.OS !== "web") {
  WebView = require("react-native-webview").WebView;
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

// ── Requirement level pin metadata ────────────────────────────────────────────
// Must match the status_level values in the service_requests table
const STATUS_META = {
  low:    { label: "No need right now",   color: "#388E3C", short: "✓"   },
  medium: { label: "Need in a week",      color: "#F57F17", short: "1w"  },
  high:   { label: "Need in 2–3 days",    color: "#E65100", short: "3d"  },
  full:   { label: "Need today — urgent", color: "#B71C1C", short: "!!!" },
};

const URGENCY_LABEL = [
  "No requirements",
  "No need right now",
  "Need in a week",
  "Need in 2–3 days",
  "Urgent — need today!",
];
const URGENCY_COLOR = ["#388E3C", "#66BB6A", "#FDD835", "#E64A19", "#C62828"];

// ─────────────────────────────────────────────────────────────────────────────
// Builds the full Leaflet HTML string from cluster + boundary data
// ─────────────────────────────────────────────────────────────────────────────
function buildHTML({ clusters, boundary, regionName, totalRequests }) {
  // Backend sends [lon, lat] — Leaflet expects [lat, lon]
  const boundaryLL = boundary.map(([lon, lat]) => [lat, lon]);
  const cLat = boundaryLL.length ? boundaryLL.reduce((s, p) => s + p[0], 0) / boundaryLL.length : 28.5;
  const cLng = boundaryLL.length ? boundaryLL.reduce((s, p) => s + p[1], 0) / boundaryLL.length : 77.0;

  const clusterData = clusters.map((c) => ({
    id:          c.cluster_id,
    name:        c.cluster_name,
    latlngs:     (c.coordinates || []).map(([lon, lat]) => [lat, lon]),
    color:       c.color,
    fillOpacity: c.opacity,
    demandCount: c.demand_count,
    urgency:     c.urgency_score,
    pins: (c.pins || []).map((p) => ({
      lat:    p.lat,
      lng:    p.lng,
      status: p.status_level,
      rid:    p.request_id,
      hasGps: p.has_gps,
    })),
  }));

  const bJSON  = JSON.stringify(boundaryLL);
  const cJSON  = JSON.stringify(clusterData);
  const smJSON = JSON.stringify(STATUS_META);
  const ulJSON = JSON.stringify(URGENCY_LABEL);
  const ucJSON = JSON.stringify(URGENCY_COLOR);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body,#map{width:100%;height:100%;}
    body{font-family:system-ui,-apple-system,sans-serif;}
    #banner{
      position:absolute;top:10px;left:50%;transform:translateX(-50%);
      background:rgba(255,255,255,0.96);border-radius:20px;
      padding:7px 18px;box-shadow:0 3px 14px rgba(0,0,0,0.2);
      z-index:1000;text-align:center;pointer-events:none;white-space:nowrap;
    }
    #legend{
      position:absolute;bottom:30px;right:10px;
      background:rgba(255,255,255,0.96);border-radius:12px;
      padding:10px 13px;box-shadow:0 3px 12px rgba(0,0,0,0.18);
      z-index:1000;min-width:155px;
    }
    .leaflet-popup-content-wrapper{border-radius:10px;}
    .leaflet-popup-content{margin:10px 13px;}
  </style>
</head>
<body>
<div id="map"></div>

<div id="banner">
  <div style="font-size:14px;font-weight:700;color:#1B5E20;">📍 ${regionName}</div>
  <div style="font-size:11px;color:#666;margin-top:1px;">
    ${totalRequests} requirement${totalRequests !== 1 ? "s" : ""} &bull; ${clusters.length} zones
  </div>
</div>

<div id="legend">
  <div style="font-size:10px;font-weight:700;color:#333;letter-spacing:1px;
    text-transform:uppercase;margin-bottom:7px;">Demand Level</div>
  <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;">
    <div style="width:13px;height:13px;border-radius:3px;background:#388E3C;
      border:1px solid rgba(0,0,0,0.1);flex-shrink:0;"></div>
    <span style="font-size:11px;color:#444;">No requirements</span>
  </div>
  <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;">
    <div style="width:13px;height:13px;border-radius:3px;background:#66BB6A;
      border:1px solid rgba(0,0,0,0.1);flex-shrink:0;"></div>
    <span style="font-size:11px;color:#444;">No need</span>
  </div>
  <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;">
    <div style="width:13px;height:13px;border-radius:3px;background:#FDD835;
      border:1px solid rgba(0,0,0,0.1);flex-shrink:0;"></div>
    <span style="font-size:11px;color:#444;">Need in a week</span>
  </div>
  <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;">
    <div style="width:13px;height:13px;border-radius:3px;background:#FB8C00;
      border:1px solid rgba(0,0,0,0.1);flex-shrink:0;"></div>
    <span style="font-size:11px;color:#444;">Need in 2–3 days</span>
  </div>
  <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;">
    <div style="width:13px;height:13px;border-radius:3px;background:#C62828;
      border:1px solid rgba(0,0,0,0.1);flex-shrink:0;"></div>
    <span style="font-size:11px;color:#444;">Urgent today 🔴</span>
  </div>
  <div style="border-top:1px solid #eee;margin:7px 0;"></div>
  <div style="display:flex;align-items:center;gap:7px;">
    <div style="width:13px;height:13px;flex-shrink:0;background:#1565C0;border:2px solid #fff;
      border-radius:50% 50% 50% 0;transform:rotate(-45deg);
      box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>
    <span style="font-size:11px;color:#444;">Requirement pin</span>
  </div>
</div>

<script>
(function(){
  var map = L.map('map', {
    center: [${cLat}, ${cLng}], zoom: 15,
    zoomControl: true, attributionControl: false
  });

  // CartoDB light_nolabels — roads + terrain, no user-added POI icons
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, subdomains: 'abcd'
  }).addTo(map);

  // Labels only layer (road names, place names) rendered below polygons
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, subdomains: 'abcd', opacity: 0.7
  }).addTo(map);

  // Region boundary
  var boundary = ${bJSON};
  if (boundary.length > 2) {
    L.polygon(boundary, {
      color: '#1B5E20', weight: 2.5, opacity: 0.9,
      fill: false, dashArray: '7 5'
    }).addTo(map);
    map.fitBounds(boundary, { padding: [20, 20] });
  }

  var clusters   = ${cJSON};
  var statusMeta = ${smJSON};
  var urgLbl     = ${ulJSON};
  var urgClr     = ${ucJSON};

  clusters.forEach(function(c) {
    if (!c.latlngs || c.latlngs.length < 3) return;

    // Cluster polygon
    var poly = L.polygon(c.latlngs, {
      color:       c.color,
      weight:      c.urgency === 4 ? 2.5 : 1.2,
      opacity:     c.urgency === 4 ? 1.0 : 0.75,
      fillColor:   c.color,
      fillOpacity: c.fillOpacity,
    }).addTo(map);

    var uLbl = urgLbl[c.urgency] || 'No requirements';
    var uClr = urgClr[c.urgency] || '#388E3C';

    poly.bindPopup(
      '<div style="font-family:system-ui;min-width:140px;">' +
        '<div style="font-size:13px;font-weight:700;color:#1B5E20;margin-bottom:5px;">'
          + c.name + '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;' +
          'color:#444;margin-bottom:3px;">' +
          '<span>Requirements</span><strong>' + c.demandCount + '</strong>' +
        '</div>' +
        '<span style="display:inline-block;margin-top:6px;padding:3px 10px;' +
          'border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:'
          + uClr + ';">' + uLbl + '</span>' +
      '</div>',
      { maxWidth: 210 }
    );

    poly.on('mouseover', function() {
      this.setStyle({ fillOpacity: Math.min(c.fillOpacity + 0.25, 0.92), weight: 2 });
    });
    poly.on('mouseout', function() {
      this.setStyle({ fillOpacity: c.fillOpacity, weight: c.urgency === 4 ? 2.5 : 1.2 });
    });

    // Requirement pins
    c.pins.forEach(function(pin) {
      // Use actual GPS if recorded, otherwise fall back to cluster centroid
      var pLat = (pin.lat != null)
        ? pin.lat
        : c.latlngs.reduce(function(s, p) { return s + p[0]; }, 0) / c.latlngs.length;
      var pLng = (pin.lng != null)
        ? pin.lng
        : c.latlngs.reduce(function(s, p) { return s + p[1]; }, 0) / c.latlngs.length;
      var approx = !pin.hasGps;

      var meta = statusMeta[pin.status] || { label: pin.status, color: '#1565C0', short: '?' };
      var sz   = 30;

      var icon = L.divIcon({
        className: '',
        iconSize:    [sz, sz],
        iconAnchor:  [sz / 2, sz],
        popupAnchor: [0, -(sz + 6)],
        html:
          '<div style="width:' + sz + 'px;height:' + sz + 'px;' +
            'background:' + meta.color + ';' +
            'border-radius:50% 50% 50% 0;transform:rotate(-45deg);' +
            'border:2.5px solid rgba(255,255,255,0.95);' +
            'box-shadow:0 3px 10px rgba(0,0,0,0.5);' +
            'display:flex;align-items:center;justify-content:center;">' +
            '<span style="transform:rotate(45deg);font-size:9px;font-weight:900;' +
              'color:#fff;line-height:1;font-family:system-ui,sans-serif;">' +
              meta.short + '</span>' +
          '</div>',
      });

      L.marker([pLat, pLng], { icon: icon })
        .addTo(map)
        .bindPopup(
          '<div style="font-family:system-ui;min-width:158px;">' +
            '<div style="font-size:12px;font-weight:700;color:#1B5E20;margin-bottom:5px;' +
              'padding-bottom:5px;border-bottom:1px solid #E8F5E9;">📌 Requirement Pin</div>' +
            (approx
              ? '<div style="font-size:10px;color:#E65100;margin-bottom:4px;' +
                'background:#FFF3E0;padding:3px 6px;border-radius:5px;">' +
                '⚠️ Approx location (no GPS recorded)</div>'
              : '') +
            '<div style="display:flex;justify-content:space-between;font-size:11px;' +
              'color:#555;margin-bottom:3px;">' +
              '<span>Zone</span><strong>' + c.name + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;font-size:10px;' +
              'color:#888;margin-bottom:3px;">' +
              '<span>Coords</span>' +
              '<span>' + Number(pLat).toFixed(5) + ', ' + Number(pLng).toFixed(5) + '</span>' +
            '</div>' +
            '<span style="display:inline-block;margin-top:6px;padding:3px 10px;' +
              'border-radius:10px;font-size:11px;font-weight:700;color:#fff;background:' +
              meta.color + ';">' + meta.label + '</span>' +
          '</div>',
          { maxWidth: 230 }
        );
    });
  });
})();
<\/script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
export default function MapScreen() {
  const { theme } = useTheme();

  const [query, setQuery]               = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching]       = useState(false);
  const [dropOpen, setDropOpen]         = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [html, setHtml]                 = useState(null);
  const [mapLoading, setMapLoading]     = useState(false);
  const [mapError, setMapError]         = useState(null);

  const debounceRef = useRef(null);

  const isDark = (theme.background ?? "#fff").startsWith("#0")
              || (theme.background ?? "#fff").startsWith("#1");
  const C = {
    bg:         theme.background ?? "#F5F7F5",
    text:       theme.text ?? "#1A1A1A",
    muted:      isDark ? "#888" : "#666",
    accent:     "#2E7D32",
    accentFade: isDark ? "#1A2E1A" : "#E8F5E9",
    card:       isDark ? "#1C1F1C" : "#FFFFFF",
    border:     isDark ? "#2A2D2A" : "#E0E0E0",
    danger:     "#C62828",
  };

  // Debounced search — waits 300ms after user stops typing before hitting API
  const handleQueryChange = (text) => {
    setQuery(text);
    if (!text.trim()) { setSearchResults([]); setDropOpen(false); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchRegions(text), 300);
  };

  const searchRegions = async (text) => {
    setSearching(true);
    try {
      const res  = await fetch(`${API_BASE}/api/search-regions/${encodeURIComponent(text.trim())}`);
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setSearchResults(data.map((r) => ({
          region:   r.region_name,
          district: r.district_name,
          state:    r.state_name,
          key:      `${r.region_name}||${r.district_name}||${r.state_name}`,
        })));
        setDropOpen(true);
      } else {
        setSearchResults([]);
        setDropOpen(false);
      }
    } catch {
      setSearchResults([]); setDropOpen(false);
    } finally {
      setSearching(false);
    }
  };

  const selectRegion = (item) => {
    setSelectedRegion(item);
    setQuery(item.region);
    setDropOpen(false);
    setSearchResults([]);
    loadMap(item.region);
  };

  const loadMap = async (regionName) => {
    setMapLoading(true); setMapError(null); setHtml(null);
    try {
      const [cRes, bRes] = await Promise.all([
        fetch(`${API_BASE}/api/zone-demand-map/${encodeURIComponent(regionName)}`),
        fetch(`${API_BASE}/api/region-boundary/${encodeURIComponent(regionName)}`),
      ]);
      const cData = await cRes.json();
      const bData = await bRes.json();
      if (cData.error) throw new Error(cData.error);
      setHtml(buildHTML({
        clusters:      cData.clusters      ?? [],
        boundary:      bData.coordinates   ?? [],
        regionName,
        totalRequests: cData.total_requests ?? 0,
      }));
    } catch (e) {
      setMapError(e.message);
    } finally {
      setMapLoading(false);
    }
  };

  return (
    <View style={[s.root, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={[s.header, { backgroundColor: C.accent }]}>
          <Text style={s.headerTitle}>Demand Map</Text>
          <Text style={s.headerSub}>Search a region to view live requirements</Text>
        </View>

        {/* Region search
            Regions are stored in the search_regions table in the database.
            Type any region, district, or state name to find it. */}
        <Text style={[s.sectionLabel, { color: C.muted }]}>SEARCH REGION</Text>

        <View style={[s.searchBox, { backgroundColor: C.card, borderColor: C.border }]}>
          <Text style={{ fontSize: 18, marginRight: 8 }}>🔍</Text>
          <TextInput
            style={[s.searchInput, { color: C.text }]}
            placeholder="Type region, district or state…"
            placeholderTextColor={C.muted}
            value={query}
            onChangeText={handleQueryChange}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searching && <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 4 }} />}
          {!!query && !searching && (
            <TouchableOpacity onPress={() => {
              setQuery(""); setSearchResults([]);
              setDropOpen(false); setSelectedRegion(null);
              setHtml(null); setMapError(null);
            }}>
              <Text style={{ color: C.muted, fontSize: 18, paddingHorizontal: 4 }}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Search results dropdown */}
        {dropOpen && searchResults.length > 0 && (
          <View style={[s.dropList, { backgroundColor: C.card, borderColor: C.border }]}>
            {searchResults.slice(0, 8).map((item) => (
              <TouchableOpacity
                key={item.key}
                style={[s.dropItem, { borderBottomColor: C.border },
                  selectedRegion?.key === item.key && { backgroundColor: C.accentFade }]}
                onPress={() => selectRegion(item)}
              >
                <Text style={{ fontSize: 18, marginRight: 12 }}>📍</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[s.dropItemTitle, { color: C.text }]}>{item.region}</Text>
                  <Text style={[s.dropItemSub, { color: C.muted }]}>
                    {item.district} · {item.state}
                  </Text>
                </View>
                {selectedRegion?.key === item.key && (
                  <View style={[s.checkBadge, { backgroundColor: C.accent }]}>
                    <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>✓</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* No results message */}
        {dropOpen && searchResults.length === 0 && !searching && query.length > 1 && (
          <View style={[s.noResults, { backgroundColor: C.card, borderColor: C.border }]}>
            <Text style={{ color: C.muted, fontSize: 13 }}>
              No regions found for "{query}". Check spelling or try a district / state name.
            </Text>
          </View>
        )}

        {/* Map placeholder */}
        {!selectedRegion && !mapLoading && !html && (
          <View style={[s.placeholder, { borderColor: C.border }]}>
            <Text style={{ fontSize: 48, marginBottom: 10 }}>🗺️</Text>
            <Text style={[s.placeholderTitle, { color: C.muted }]}>No region selected</Text>
            <Text style={[s.placeholderSub, { color: C.muted }]}>
              Search above and select a region to load its demand map
            </Text>
          </View>
        )}

        {/* Map loading */}
        {mapLoading && (
          <View style={[s.mapFrame, s.mapCenter, { backgroundColor: C.card, borderColor: C.border }]}>
            <ActivityIndicator size="large" color={C.accent} />
            <Text style={[s.loadingText, { color: C.muted }]}>Loading map…</Text>
          </View>
        )}

        {/* Map error */}
        {mapError && !mapLoading && (
          <View style={[s.mapFrame, s.mapCenter, { backgroundColor: C.card, borderColor: C.border }]}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>⚠️</Text>
            <Text style={[s.errorText, { color: C.danger }]}>{mapError}</Text>
            <TouchableOpacity
              style={[s.retryBtn, { backgroundColor: C.accent }]}
              onPress={() => selectedRegion && loadMap(selectedRegion.region)}
            >
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* The map */}
        {html && !mapLoading && !mapError && (
          <View style={s.mapFrame}>
            {Platform.OS === "web" ? (
              // Web: iframe without sandbox (sandbox blocks unpkg CDN scripts)
              <iframe
                srcDoc={html}
                style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                title={selectedRegion?.region ?? "Demand Map"}
              />
            ) : (
              // Android / iOS
              <WebView
                source={{ html, baseUrl: "https://unpkg.com" }}
                style={{ flex: 1 }}
                originWhitelist={["*"]}
                javaScriptEnabled
                domStorageEnabled
                mixedContentMode="always"
                onError={(e) => setMapError(e.nativeEvent.description)}
              />
            )}
          </View>
        )}

      </ScrollView>
      <BottomTabs />
    </View>
  );
}

const MAP_HEIGHT = 460;

const s = StyleSheet.create({
  root:            { flex: 1 },
  scroll:          { padding: 20, paddingBottom: 110 },
  header:          { borderRadius: 20, padding: 22, marginBottom: 20,
                     shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 6 },
                     shadowOpacity: 0.25, shadowRadius: 14, elevation: 7 },
  headerTitle:     { color: "#fff", fontSize: 22, fontWeight: "800" },
  headerSub:       { color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 4 },
  sectionLabel:    { fontSize: 11, fontWeight: "700", letterSpacing: 1.5, marginBottom: 10 },
  searchBox:       { flexDirection: "row", alignItems: "center", borderWidth: 1.5,
                     borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
                     marginBottom: 4,
                     shadowColor: "#000", shadowOffset: { width: 0, height: 2 },
                     shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  searchInput:     { flex: 1, fontSize: 15 },
  dropList:        { borderWidth: 1.5, borderRadius: 14, overflow: "hidden", marginBottom: 16,
                     shadowColor: "#000", shadowOffset: { width: 0, height: 4 },
                     shadowOpacity: 0.08, shadowRadius: 10, elevation: 5 },
  dropItem:        { flexDirection: "row", alignItems: "center",
                     paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1 },
  dropItemTitle:   { fontSize: 15, fontWeight: "600" },
  dropItemSub:     { fontSize: 12, marginTop: 2 },
  checkBadge:      { width: 22, height: 22, borderRadius: 11,
                     alignItems: "center", justifyContent: "center", marginLeft: 8 },
  noResults:       { borderWidth: 1.5, borderRadius: 12, padding: 14, marginBottom: 16 },
  placeholder:     { height: 220, borderRadius: 16, borderWidth: 1.5,
                     borderStyle: "dashed", alignItems: "center",
                     justifyContent: "center", marginBottom: 12, paddingHorizontal: 20 },
  placeholderTitle:{ fontSize: 15, fontWeight: "600", marginBottom: 6, textAlign: "center" },
  placeholderSub:  { fontSize: 13, textAlign: "center", lineHeight: 19 },
  mapFrame:        { width: "100%", height: MAP_HEIGHT, borderRadius: 16,
                     overflow: "hidden", backgroundColor: "#E8F5E9",
                     shadowColor: "#000", shadowOffset: { width: 0, height: 6 },
                     shadowOpacity: 0.15, shadowRadius: 16, elevation: 8, marginBottom: 12 },
  mapCenter:       { alignItems: "center", justifyContent: "center",
                     borderWidth: 1, borderColor: "#C8E6C9" },
  loadingText:     { marginTop: 12, fontSize: 13 },
  errorText:       { fontSize: 13, fontWeight: "600", textAlign: "center",
                     paddingHorizontal: 24, marginBottom: 14 },
  retryBtn:        { paddingVertical: 9, paddingHorizontal: 24, borderRadius: 10 },
});