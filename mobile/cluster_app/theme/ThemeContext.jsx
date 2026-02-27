import React, { createContext, useContext, useState } from "react";

const ThemeContext = createContext();

const lightTheme = {
  background: "#ffffff",
  text: "#000000",
  button: "#1DA1F2",
  buttonText: "#ffffff",
  border: "#e5e7eb",
};

const darkTheme = {
  background: "#000000",
  text: "#ffffff",
  button: "#1DA1F2",
  buttonText: "#ffffff",
  border: "#222",
};

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState("light");

  const theme = mode === "light" ? lightTheme : darkTheme;

  const setLight = () => setMode("light");
  const setDark = () => setMode("dark");

  return (
    <ThemeContext.Provider value={{ theme, mode, setLight, setDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);