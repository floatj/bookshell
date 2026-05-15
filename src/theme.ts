/** macOS-style design tokens shared across all components. */

export const C = {
  bg:         "#1c1c1e",
  bg2:        "#2c2c2e",
  bg3:        "#3a3a3c",
  bgHover:    "rgba(255,255,255,0.07)",
  bgActive:   "rgba(255,255,255,0.12)",
  border:     "rgba(255,255,255,0.1)",
  borderSub:  "rgba(255,255,255,0.06)",
  text:       "#f2f2f7",
  text2:      "rgba(242,242,247,0.55)",
  text3:      "rgba(242,242,247,0.28)",
  accent:     "#0a84ff",
  accentBg:   "rgba(10,132,255,0.18)",
  accentBdr:  "rgba(10,132,255,0.4)",
  green:      "#30d158",
  greenBg:    "rgba(48,209,88,0.15)",
  red:        "#ff453a",
  redBg:      "rgba(255,69,58,0.18)",
  yellow:     "#ffd60a",
  orange:     "#ff9f0a",
  purple:     "#bf5af2",
  tRed:       "#ff5f57",
  tYellow:    "#ffbd2e",
  tGreen:     "#28c840",
} as const;

/** xterm.js theme that matches the macOS dark palette. */
export const xtermTheme = {
  background:         C.bg,
  foreground:         C.text,
  cursor:             C.text,
  cursorAccent:       C.bg,
  selectionBackground:"rgba(10,132,255,0.3)",
  black:   "#000000", red:     C.red,    green: C.green,  yellow: C.yellow,
  blue:    C.accent,  magenta: C.purple, cyan:  "#5ac8fa", white: "#ebebf5",
  brightBlack:   "#636366", brightRed:     "#ff6961",
  brightGreen:   "#34c759", brightYellow:  C.yellow,
  brightBlue:    "#409cff", brightMagenta: "#da8fff",
  brightCyan:    "#70d7ff", brightWhite:   "#ffffff",
} as const;

/** 16-color ANSI palette indexed 0..15 (basic + bright), drawn from
 *  xtermTheme so the hover preview popover paints with the same hues the
 *  live terminal uses. Index 0 is black to match xterm convention. */
const ANSI16: readonly string[] = [
  "#000000",            xtermTheme.red,           xtermTheme.green,   xtermTheme.yellow,
  xtermTheme.blue,      xtermTheme.magenta,       xtermTheme.cyan,    xtermTheme.white,
  xtermTheme.brightBlack, xtermTheme.brightRed,   xtermTheme.brightGreen, xtermTheme.brightYellow,
  xtermTheme.brightBlue,  xtermTheme.brightMagenta, xtermTheme.brightCyan, xtermTheme.brightWhite,
];

/** Step values for xterm's 6×6×6 RGB cube (palette indices 16..231). */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/** Resolve a palette index (0..255) into a CSS color string using the macOS
 *  xterm theme for the first 16 entries, the canonical 6×6×6 cube for
 *  16..231, and the 24-step grayscale ramp for 232..255. */
export function ansiPaletteColor(idx: number): string {
  if (idx < 16) return ANSI16[idx];
  if (idx < 232) {
    const i = idx - 16;
    const r = CUBE_STEPS[Math.floor(i / 36) % 6];
    const g = CUBE_STEPS[Math.floor(i / 6) % 6];
    const b = CUBE_STEPS[i % 6];
    return `rgb(${r},${g},${b})`;
  }
  const gray = 8 + (idx - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

export const overlayStyle = {
  position:           "fixed",
  inset:              "0",
  background:         "rgba(0,0,0,0.45)",
  "backdrop-filter":  "blur(6px)",
  display:            "flex",
  "align-items":      "center",
  "justify-content":  "center",
  "z-index":          "100",
} as const;

export const dialogStyle = {
  position:           "relative",
  background:         "rgba(30,30,32,0.97)",
  "backdrop-filter":  "blur(40px) saturate(180%)",
  color:              C.text,
  border:             `1px solid ${C.border}`,
  "border-radius":    "14px",
  "box-shadow":       "0 24px 64px rgba(0,0,0,0.75), 0 4px 16px rgba(0,0,0,0.4)",
  padding:            "20px",
} as const;

export const inputStyle = {
  background:     C.bg3,
  color:          C.text,
  border:         `1px solid ${C.border}`,
  padding:        "7px 10px",
  "border-radius":"8px",
  "font-size":    "13px",
  outline:        "none",
} as const;

/** Primary action button (blue). */
export const btnPrimary = {
  background:     C.accent,
  color:          "#fff",
  border:         "none",
  "border-radius":"8px",
  padding:        "6px 14px",
  "font-size":    "13px",
  cursor:         "pointer",
  "font-weight":  600,
} as const;

/** Secondary/ghost button. */
export const btnSecondary = {
  background:     C.bg3,
  color:          C.text,
  border:         `1px solid ${C.border}`,
  "border-radius":"8px",
  padding:        "6px 14px",
  "font-size":    "13px",
  cursor:         "pointer",
  "font-weight":  500,
} as const;

/** Danger button (red). */
export const btnDanger = {
  background:     C.red,
  color:          "#fff",
  border:         "none",
  "border-radius":"8px",
  padding:        "6px 14px",
  "font-size":    "13px",
  cursor:         "pointer",
  "font-weight":  600,
} as const;
