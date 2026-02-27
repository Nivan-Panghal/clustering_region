// BottomTabs.js — Bottom navigation bar
// Routes: /  (Location setup)  |  /request  (Requirement)  |  /map  (Demand Map)

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "../theme/ThemeContext";
import { useRouter, usePathname } from "expo-router";

const TABS = [
  { label: "Location",    route: "/",        icon: "location"  },
  { label: "Requirement", route: "/RequestService", icon: "cube"      },
  { label: "Map",         route: "/MapScreen",     icon: "map"       },
];

export default function BottomTabs({ visible = true }) {
  const { theme } = useTheme();
  const router    = useRouter();
  const pathname  = usePathname();

  if (!visible) return null;

  return (
    <View style={[s.bar, { backgroundColor: theme.background, borderColor: theme.border }]}>
      {TABS.map(({ label, route, icon }) => {
        const active = pathname === route;
        const color  = active ? (theme.primary ?? "#2E7D32") : (theme.text ?? "#333");
        return (
          <TouchableOpacity key={route} style={s.tab} onPress={() => router.push(route)}>
            <Ionicons
              name={active ? icon : `${icon}-outline`}
              size={26} color={color}
            />
            <Text style={{ color, fontSize: 11, marginTop: 2, fontWeight: active ? "700" : "400" }}>
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    position: "absolute", bottom: 0, left: 0, right: 0, height: 70,
    flexDirection: "row", justifyContent: "space-around", alignItems: "center",
    borderTopWidth: 1, zIndex: 1000,
  },
  tab: { alignItems: "center", flex: 1, paddingVertical: 6 },
});