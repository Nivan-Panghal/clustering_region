// RequestScreen.js — Customer Requirement Submission
// ─────────────────────────────────────────────────────────────────────────────
// This is the customer-facing screen.
// In a production system, customer requirements could be derived automatically
// from IoT sensors, order history, or behavioral analytics — eliminating the
// need for manual input.
// In some type of services user's manual input makes sense!
// This manual submission screen exists to simulate that data flow, making the
// full pipeline demonstrable without additional hardware or integrations.
//
// Data written to: service_requests table (via POST /api/service-request)
// Also stored in AsyncStorage: lastRequestDate, lastRequestLevel (for UI state)
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, ScrollView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "../theme/ThemeContext";
import BottomTabs from "../components/BottomTabs";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

// Requirement levels — stored as status_level in service_requests table.
// These map to urgency scores (1–4) used by the backend color-coding logic.
const REQUIREMENT_LEVELS = [
  { id: "low",    label: "No need right now",   icon: "🟢", desc: "Zone is currently fine"      },
  { id: "medium", label: "Need in a week",       icon: "🟡", desc: "Plan a visit soon"           },
  { id: "high",   label: "Need in 2–3 days",     icon: "🟠", desc: "Prepare for prompt service"  },
  { id: "full",   label: "Need today — urgent!", icon: "🔴", desc: "Immediate attention required" },
];

export default function RequestScreen() {
  const { theme } = useTheme();

  const [level, setLevel]               = useState("");
  const [dropOpen, setDropOpen]         = useState(false);
  const [regionName, setRegionName]     = useState(null);
  const [clusterName, setClusterName]   = useState(null);
  const [userId, setUserId]             = useState(null);
  const [submitting, setSubmitting]     = useState(false);
  const [gpsLoading, setGpsLoading]     = useState(false);
  const [loading, setLoading]           = useState(true);
  const [canRequest, setCanRequest]     = useState(true);
  const [statusMsg, setStatusMsg]       = useState("");
  const [isError, setIsError]           = useState(false);
  const [submittedLevel, setSubmittedLevel] = useState(null);

  const today = new Date().toISOString().split("T")[0];

  useEffect(() => {
    (async () => {
      const [region, uid, lastDate, cluster, lastLevel] = await Promise.all([
        AsyncStorage.getItem("regionName"),
        AsyncStorage.getItem("userId"),
        AsyncStorage.getItem("lastRequestDate"),
        AsyncStorage.getItem("clusterName"),
        AsyncStorage.getItem("lastRequestLevel"),
      ]);
      if (region)    setRegionName(region);
      if (uid)       setUserId(uid);
      if (cluster)   setClusterName(cluster);
      if (lastLevel) setSubmittedLevel(lastLevel);
      if (lastDate === today) {
        setCanRequest(false);
        setLevel(lastLevel ?? "");
      }
      setLoading(false);
    })();
  }, []);

  // Always fetch fresh GPS at submission time (not the cached setup value)
  const getFreshGPS = async () => {
    setGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return null;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      return { lat: loc.coords.latitude, lng: loc.coords.longitude };
    } catch {
      return null;
    } finally {
      setGpsLoading(false);
    }
  };

  const submitRequest = async () => {
    if (!level || !canRequest) return;
    setSubmitting(true); setIsError(false); setStatusMsg("");
    try {
      const gps = await getFreshGPS();
      const res = await fetch(`${API_BASE}/api/service-request`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id:   userId,
          region_name:  regionName,
          cluster_name: clusterName,
          status_level: level,
          latitude:     gps?.lat ?? null,
          longitude:    gps?.lng ?? null,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await AsyncStorage.setItem("lastRequestDate",  today);
      await AsyncStorage.setItem("lastRequestLevel", level);
      setSubmittedLevel(level);
      setCanRequest(false);
      setStatusMsg("Requirement submitted successfully!");
    } catch (err) {
      setIsError(true);
      setStatusMsg("Failed to submit: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteRequest = async () => {
    Alert.alert("Delete Requirement", "Remove your current requirement?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try {
            if (userId) {
              await fetch(`${API_BASE}/api/service-request/${userId}`, { method: "DELETE" });
            }
            await AsyncStorage.multiRemove(["lastRequestDate", "lastRequestLevel"]);
            setCanRequest(true); setLevel(""); setSubmittedLevel(null);
            setIsError(false); setStatusMsg("Requirement deleted. You can submit again.");
          } catch {
            setIsError(true); setStatusMsg("Failed to delete. Check your connection.");
          }
        },
      },
    ]);
  };

  const isDark = (theme.background ?? "#fff").startsWith("#0")
              || (theme.background ?? "#fff").startsWith("#1");
  const C = {
    bg:     theme.background ?? "#F5F7F5",
    card:   isDark ? "#1C1F1C" : "#FFFFFF",
    text:   theme.text ?? "#1A1A1A",
    muted:  isDark ? "#888" : "#666",
    border: isDark ? "#2A2D2A" : "#E0E0E0",
    accent: "#2E7D32",
    danger: "#C62828",
  };

  const selectedMeta = REQUIREMENT_LEVELS.find((l) => l.id === level);

  if (loading) return (
    <View style={[s.center, { backgroundColor: C.bg }]}>
      <ActivityIndicator size="large" color={C.accent} />
    </View>
  );

  return (
    <View style={[s.root, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={[s.header, { backgroundColor: C.accent }]}>
          <Text style={s.headerTitle}>Submit Requirement</Text>
          <Text style={s.headerSub}>Report what your needs right now</Text>
        </View>

        {/* Zone info or warning */}
        {regionName ? (
          <View style={[s.zoneCard, { backgroundColor: C.card, borderColor: C.border }]}>
            <Text style={[s.zoneLabel, { color: C.muted }]}>YOUR REGION</Text>
            <Text style={[s.zoneRegion, { color: C.text }]}>📍  {regionName}</Text>
            {clusterName ? (
              <Text style={[s.zoneCluster, { color: C.muted }]}>Zone: {clusterName}</Text>
            ) : null}
          </View>
        ) : (
          <View style={[s.warnCard, { backgroundColor: "#FFF3E0", borderColor: "#FFB74D" }]}>
            <Text style={{ color: "#E65100", fontSize: 13, lineHeight: 19 }}>
              ⚠️  No region detected. Please go to the Location tab and allow GPS first.
            </Text>
          </View>
        )}

        {/* Today's submitted requirement — shown when already submitted */}
        {!canRequest && submittedLevel && (
          <View style={[s.submittedCard, { backgroundColor: C.card, borderColor: C.accent }]}>
            <Text style={[s.submittedLabel, { color: C.muted }]}>TODAY'S REQUIREMENT</Text>
            <Text style={{ fontSize: 32, marginVertical: 6 }}>
              {REQUIREMENT_LEVELS.find((l) => l.id === submittedLevel)?.icon ?? "📝"}
            </Text>
            <Text style={[s.submittedValue, { color: C.text }]}>
              {REQUIREMENT_LEVELS.find((l) => l.id === submittedLevel)?.label ?? submittedLevel}
            </Text>
          </View>
        )}

        {/* Requirement level picker — only when can submit */}
        {canRequest && (
          <>
            <Text style={[s.sectionLabel, { color: C.muted }]}>REQUIREMENT LEVEL</Text>

            <TouchableOpacity
              style={[s.dropTrigger, { backgroundColor: C.card,
                borderColor: selectedMeta ? C.accent : C.border }]}
              onPress={() => setDropOpen(!dropOpen)}
            >
              <Text style={[s.dropTriggerText, { color: selectedMeta ? C.text : C.muted }]}>
                {selectedMeta ? `${selectedMeta.icon}  ${selectedMeta.label}` : "Select requirement level…"}
              </Text>
              <Ionicons name={dropOpen ? "chevron-up" : "chevron-down"} size={20} color={C.muted} />
            </TouchableOpacity>

            {dropOpen && (
              <View style={[s.dropList, { backgroundColor: C.card, borderColor: C.border }]}>
                {REQUIREMENT_LEVELS.map((l) => (
                  <TouchableOpacity
                    key={l.id}
                    style={[s.dropItem, { borderBottomColor: C.border },
                            level === l.id && { backgroundColor: isDark ? "#1A2E1A" : "#E8F5E9" }]}
                    onPress={() => { setLevel(l.id); setDropOpen(false); }}
                  >
                    <Text style={{ fontSize: 22, marginRight: 12 }}>{l.icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.dropItemTitle, { color: C.text }]}>{l.label}</Text>
                      <Text style={[s.dropItemDesc,  { color: C.muted }]}>{l.desc}</Text>
                    </View>
                    {level === l.id && (
                      <View style={[s.checkBadge, { backgroundColor: C.accent }]}>
                        <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>✓</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <TouchableOpacity
              style={[s.submitBtn, { backgroundColor: C.accent },
                (!level || submitting || gpsLoading) && s.disabled]}
              disabled={!level || submitting || gpsLoading}
              onPress={submitRequest}
            >
              {submitting || gpsLoading
                ? <ActivityIndicator color="#fff" />
                : <>
                    <Text style={{ fontSize: 20, marginRight: 10 }}>📤</Text>
                    <Text style={s.submitBtnLabel}>
                      {gpsLoading ? "Getting GPS…" : "Submit Requirement"}
                    </Text>
                  </>
              }
            </TouchableOpacity>
          </>
        )}

        {/* Status / error message */}
        {!!statusMsg && (
          <View style={[s.statusBox, {
            backgroundColor: C.card,
            borderColor: isError ? C.danger : C.accent,
          }]}>
            <Text style={{ color: isError ? C.danger : C.accent, fontSize: 13, textAlign: "center" }}>
              {isError ? "⚠️  " : "✅  "}{statusMsg}
            </Text>
          </View>
        )}

        {/* Delete button */}
        {!canRequest && (
          <TouchableOpacity style={[s.deleteBtn, { borderColor: C.danger }]} onPress={deleteRequest}>
            <Text style={{ fontSize: 18, marginRight: 8 }}>🗑️</Text>
            <Text style={[s.deleteBtnLabel, { color: C.danger }]}>Delete Previous Requirement</Text>
          </TouchableOpacity>
        )}

      </ScrollView>
      <BottomTabs />
    </View>
  );
}

const s = StyleSheet.create({
  root:           { flex: 1 },
  center:         { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll:         { padding: 20, paddingBottom: 120 },
  header:         { borderRadius: 20, padding: 22, marginBottom: 20,
                    shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 6 },
                    shadowOpacity: 0.25, shadowRadius: 14, elevation: 7 },
  headerTitle:    { color: "#fff", fontSize: 22, fontWeight: "800" },
  headerSub:      { color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 4 },
  zoneCard:       { borderWidth: 1.5, borderRadius: 14, padding: 14, marginBottom: 20 },
  zoneLabel:      { fontSize: 10, fontWeight: "700", letterSpacing: 1.2, marginBottom: 6 },
  zoneRegion:     { fontSize: 17, fontWeight: "800" },
  zoneCluster:    { fontSize: 12, marginTop: 3 },
  warnCard:       { borderWidth: 1.5, borderRadius: 14, padding: 14, marginBottom: 20 },
  submittedCard:  { borderWidth: 2, borderRadius: 16, padding: 18,
                    alignItems: "center", marginBottom: 20 },
  submittedLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1.3 },
  submittedValue: { fontSize: 16, fontWeight: "600" },
  sectionLabel:   { fontSize: 11, fontWeight: "700", letterSpacing: 1.5, marginBottom: 10 },
  dropTrigger:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                    borderWidth: 1.5, borderRadius: 14, padding: 14, marginBottom: 6 },
  dropTriggerText:{ fontSize: 15, flex: 1 },
  dropList:       { borderWidth: 1.5, borderRadius: 14, overflow: "hidden", marginBottom: 20,
                    shadowColor: "#000", shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.08, shadowRadius: 10, elevation: 5 },
  dropItem:       { flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1 },
  dropItemTitle:  { fontSize: 15, fontWeight: "600" },
  dropItemDesc:   { fontSize: 11, marginTop: 2 },
  checkBadge:     { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  submitBtn:      { flexDirection: "row", alignItems: "center", justifyContent: "center",
                    paddingVertical: 16, borderRadius: 16, marginBottom: 16,
                    shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 6 },
                    shadowOpacity: 0.3, shadowRadius: 12, elevation: 7 },
  submitBtnLabel: { color: "#fff", fontSize: 17, fontWeight: "800" },
  disabled:       { opacity: 0.45 },
  statusBox:      { borderWidth: 1.5, borderRadius: 12, padding: 12, marginBottom: 16 },
  deleteBtn:      { flexDirection: "row", alignItems: "center", justifyContent: "center",
                    borderWidth: 1.5, borderRadius: 14, paddingVertical: 13, marginTop: 4 },
  deleteBtnLabel: { fontSize: 15, fontWeight: "700" },
});