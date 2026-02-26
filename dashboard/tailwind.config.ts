import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "bg-primary": "#000000",
        "bg-surface": "#0A0A0A",
        "bg-surface-raised": "#111111",
        "border-primary": "#1A1A1A",
        "border-hover": "#2A2A2A",
        "text-primary": "#FFFFFF",
        "text-secondary": "#888888",
        "text-muted": "#555555",
        accent: "#00FF88",
        "accent-dim": "rgba(0, 255, 136, 0.2)",
        warning: "#FFB800",
        error: "#FF3366",
        success: "#00FF88",
      },
      fontFamily: {
        heading: ["var(--font-cormorant)"],
        mono: ["var(--font-jetbrains)"],
        body: ["var(--font-outfit)"],
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        breathe: "breathe 4s ease-in-out infinite",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": {
            boxShadow: "0 0 4px rgba(0, 255, 136, 0.2)",
          },
          "50%": {
            boxShadow: "0 0 16px rgba(0, 255, 136, 0.6)",
          },
        },
        breathe: {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.02)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
