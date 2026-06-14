/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        body: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        surface: {
          DEFAULT: "#0f0f0f",
          raised: "#161616",
          overlay: "#1c1c1c",
          border: "#262626",
          hover: "#2a2a2a",
        },
        alert: {
          DEFAULT: "#ef4444",
          dim: "rgba(239,68,68,0.15)",
          glow: "rgba(239,68,68,0.4)",
        },
        caution: {
          DEFAULT: "#f59e0b",
          dim: "rgba(245,158,11,0.15)",
        },
        safe: {
          DEFAULT: "#22c55e",
          dim: "rgba(34,197,94,0.15)",
        },
        neutral: {
          DEFAULT: "#6b7280",
          text: "#a3a3a3",
          muted: "#525252",
        },
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(24px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 8px rgba(239,68,68,0.2)" },
          "50%": { boxShadow: "0 0 20px rgba(239,68,68,0.5)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "border-dance": {
          "0%, 100%": { borderColor: "rgba(239,68,68,0.2)" },
          "50%": { borderColor: "rgba(239,68,68,0.5)" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        "slide-up": "slide-up 0.4s ease-out",
        "slide-in-right": "slide-in-right 0.35s ease-out",
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "fade-in": "fade-in 0.3s ease-out",
        "border-dance": "border-dance 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
