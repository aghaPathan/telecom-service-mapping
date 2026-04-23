import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "media",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Instrument Serif'", "ui-serif", "Georgia", "serif"],
        sans: [
          "'Geist'",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "sans-serif",
        ],
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        ink: {
          DEFAULT: "#0b0b0c",
          soft: "#1a1a1c",
        },
        paper: {
          DEFAULT: "#f7f5ef",
          soft: "#eeece3",
        },
        accent: {
          DEFAULT: "#c2410c",
          soft: "#fb923c",
        },
      },
      letterSpacing: {
        widest2: "0.25em",
      },
    },
  },
  plugins: [],
};

export default config;
