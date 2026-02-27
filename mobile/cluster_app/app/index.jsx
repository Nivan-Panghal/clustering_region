// index.js — Location Setup Screen
// ─────────────────────────────────────────────────────────────────────────────

// Flow:
//   First launch  → show heading + "Allow GPS" button
//                 → tap button → request permission → get GPS coords (latitude & longitude)
//                 → POST /api/find-zone → receive region + cluster name
//                 → store all data in AsyncStorage 
//
//   Later launches → setupDone = "true" in AsyncStorage → showing stored region name

// NOTE: Region and cluster polygon data is stored in PostgreSQL.
//       The /api/find-zone endpoint uses PostGIS ST_Contains() to find
//       which cluster polygon the GPS coordinates fall inside.
//       The region name returned is then used in RequestScreen and MapScreen.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Animated, Alert, ScrollView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { useTheme } from "../theme/ThemeContext";
import BottomTabs from "../components/BottomTabs";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

// AsyncStorage keys — shared across all 3 screens
export const KEYS = {
  userId:        "userId",
  regionName:    "regionName",
  clusterName:   "clusterName",
  userLat:       "userLat",
  userLng:       "userLng",
  setupDone:     "setupDone",
  locationLabel: "locationLabel",
};

export default function LocationSetupScreen() {
  const { theme } = useTheme();

  
  const [phase, setPhase]         = useState("checking");
  const [errorMsg, setErrorMsg]   = useState("");
  const [storedLabel, setStoredLabel] = useState("");

  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  const animIn = () => {
    fadeAnim.setValue(0); slideAnim.setValue(20);
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  };

  useEffect(() => { boot(); }, []);

  const boot = async () => {
    const done  = await AsyncStorage.getItem(KEYS.setupDone);
    const label = await AsyncStorage.getItem(KEYS.locationLabel);
    if (done === "true" && label) {
      setStoredLabel(label);
      setPhase("done");
    } else {
      setPhase("prompt");
    }
    animIn();
  };

  // ── Main GPS flow ─────────────────────────────────────────────────────────
  const handleAllowGPS = async () => {
    setErrorMsg("");
    setPhase("loading");

    try {
      // Step 1 — permission
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setErrorMsg("Location permission was denied. Please allow it in your device settings and try again.");
        setPhase("prompt");
        return;
      }

      // Step 2 — get high-accuracy GPS fix
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const lat = loc.coords.latitude;
      const lng = loc.coords.longitude;

      // Step 3 — find which cluster zone these coords belong to
      let region  = "";
      let cluster = "";
      try {
        const res  = await fetch(`${API_BASE}/api/find-zone`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ lat, lng }),
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        if (data.region) {
          region  = data.region;
          cluster = data.cluster ?? "";
        } else {
          // GPS worked but coords are outside all mapped regions in DB
          setErrorMsg(
            "Your location is outside any mapped region. " 
          );
          setPhase("prompt");
          return;
        }
      } catch (apiErr) {
        setErrorMsg(
          "Could not reach the server to detect your zone. " +
          "Check your connection and try again.\n\n" + apiErr.message
        );
        setPhase("prompt");
        return;
      }

      // Step 4 — generate user ID if not already set
      let uid = await AsyncStorage.getItem(KEYS.userId);
      if (!uid) {
        uid = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }

      // Step 5 — persist everything
      const label = region;
      await AsyncStorage.multiSet([
        [KEYS.userId,        uid],
        [KEYS.userLat,       String(lat)],
        [KEYS.userLng,       String(lng)],
        [KEYS.regionName,    region],
        [KEYS.clusterName,   cluster],
        [KEYS.locationLabel, label],
        [KEYS.setupDone,     "true"],
      ]);

      setStoredLabel(label);
      setPhase("done");
      animIn();

    } catch (err) {
      setErrorMsg("GPS error: " + err.message + "\n\nMake sure GPS is enabled on your device.");
      setPhase("prompt");
    }
  };

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = () => {
    Alert.alert(
      "Reset Location",
      "This will clear your saved location. User will need to allow GPS again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset", style: "destructive",
          onPress: async () => {
            await AsyncStorage.multiRemove(Object.values(KEYS));
            setStoredLabel("");
            setErrorMsg("");
            setPhase("prompt");
            animIn();
          },
        },
      ]
    );
  };

  const isDark = (theme.background ?? "#fff").startsWith("#0")
              || (theme.background ?? "#fff").startsWith("#1");
  const C = {
    bg:     theme.background ?? "#F5F7F5",
    text:   theme.text ?? "#1A1A1A",
    muted:  isDark ? "#888" : "#666",
    accent: "#2E7D32",
    card:   isDark ? "#1C1F1C" : "#FFFFFF",
    border: isDark ? "#2A2D2A" : "#E0E0E0",
    danger: "#C62828",
  };

  if (phase === "checking") {
    return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  return (
    <View style={[s.root, { backgroundColor: C.bg }]}>
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View style={[s.inner, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

          
          {/* ── PROMPT ── */}
          {phase === "prompt" && (
            <>
              <Text style={[s.title, { color: C.text }]}>Select Your Location</Text>
              <Text style={[s.subtitle, { color: C.muted }]}>
                You must allow location permission so the app can assign you to the correct service zone.
              </Text>

              {/* Error message */}
              {!!errorMsg && (
                <View style={[s.errorBox, { backgroundColor: isDark ? "#2A1010" : "#FFF5F5",
                  borderColor: C.danger }]}>
                  <Text style={{ color: C.danger, fontSize: 13, lineHeight: 19 }}>
                    ⚠️  {errorMsg}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[s.gpsBtn, { backgroundColor: C.accent }]}
                onPress={handleAllowGPS}
              >
                <Text style={{ fontSize: 22, marginRight: 10 }}>📡</Text>
                <Text style={s.gpsBtnLabel}>Allow GPS & Continue</Text>
              </TouchableOpacity>

              <View style={[s.infoCard, { backgroundColor: C.card, borderColor: C.border }]}>
                <Text style={[s.infoTitle, { color: C.text }]}>Why do we need your location?</Text>
                <Text style={[s.infoBody, { color: C.muted }]}>
                  Your GPS coordinates are matched against cluster zone boundaries stored in the
                  database. This assigns you to a specific service zone so your requirements are
                  tracked accurately on the demand map.
                </Text>
              </View>
            </>
          )}

          {/* ── LOADING ── */}
          {phase === "loading" && (
            <>
              <Text style={[s.title, { color: C.text }]}>Detecting Zone…</Text>
              <ActivityIndicator
                size="large"
                color={C.accent}
                style={{ marginVertical: 32 }}
              />
              <Text style={[s.subtitle, { color: C.muted }]}>
                Getting your GPS location and matching it to a service zone.
              </Text>
            </>
          )}

          {/* ── DONE ── */}
          {phase === "done" && (
            <>
              <View style={[s.successIcon, { backgroundColor: isDark ? "#1A2E1A" : "#E8F5E9" }]}>
                <Text style={{ fontSize: 38 }}>✅</Text>
              </View>

              <Text style={[s.title, { color: C.text }]}>Location Stored</Text>

              <View style={[s.locationCard, { backgroundColor: C.card, borderColor: C.accent }]}>
                <Text style={[s.locationCardLabel, { color: C.muted }]}>YOUR REGION</Text>
                <Text style={[s.locationCardValue, { color: C.text }]}>📍  {storedLabel}</Text>
              </View>

              

              <TouchableOpacity
                style={[s.resetBtn, { borderColor: C.danger }]}
                onPress={handleReset}
              >
                <Text style={{ fontSize: 16, marginRight: 8, color: C.danger }}>↺</Text>
                <Text style={[s.resetLabel, { color: C.danger }]}>Reset Location</Text>
              </TouchableOpacity>
            </>
          )}

        </Animated.View>
      </ScrollView>
      <BottomTabs />
    </View>
  );
}

const s = StyleSheet.create({
  root:             { flex: 1 },
  scroll:           { flexGrow: 1, justifyContent: "center", padding: 24, paddingBottom: 110 },
  inner:            { alignItems: "center" },
  
  title:            { fontSize: 26, fontWeight: "800", textAlign: "center",
                      marginBottom: 12, letterSpacing: -0.3 },
  subtitle:         { fontSize: 14, textAlign: "center", lineHeight: 22,
                      marginBottom: 24, paddingHorizontal: 8, color: "#666" },
  errorBox:         { borderWidth: 1.5, borderRadius: 12, padding: 14,
                      marginBottom: 20, width: "100%" },
  gpsBtn:           { flexDirection: "row", alignItems: "center", justifyContent: "center",
                      width: "100%", paddingVertical: 16, borderRadius: 14, marginBottom: 20,
                      shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 5 },
                      shadowOpacity: 0.28, shadowRadius: 12, elevation: 6 },
  gpsBtnLabel:      { color: "#fff", fontSize: 17, fontWeight: "700" },
  infoCard:         { borderWidth: 1.5, borderRadius: 14, padding: 16, width: "100%" },
  infoTitle:        { fontSize: 13, fontWeight: "700", marginBottom: 8 },
  infoBody:         { fontSize: 13, lineHeight: 20 },
  successIcon:      { width: 80, height: 80, borderRadius: 22, alignItems: "center",
                      justifyContent: "center", marginBottom: 20 },
  locationCard:     { borderWidth: 2, borderRadius: 16, padding: 20,
                      width: "100%", alignItems: "center", marginBottom: 20 },
  locationCardLabel:{ fontSize: 10, fontWeight: "700", letterSpacing: 1.5, marginBottom: 8 },
  locationCardValue:{ fontSize: 22, fontWeight: "800" },
  doneHint:         { fontSize: 13, textAlign: "center", lineHeight: 21,
                      marginBottom: 28, paddingHorizontal: 10 },
  resetBtn:         { flexDirection: "row", alignItems: "center", justifyContent: "center",
                      borderWidth: 1.5, borderRadius: 12,
                      paddingVertical: 12, paddingHorizontal: 28 },
  resetLabel:       { fontSize: 14, fontWeight: "700" },
});