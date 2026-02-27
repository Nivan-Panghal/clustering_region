import { Stack } from "expo-router";
import { ThemeProvider } from "../theme/ThemeContext";

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Stack />
    </ThemeProvider>
  );
}