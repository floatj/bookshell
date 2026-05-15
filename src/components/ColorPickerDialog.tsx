import { createMemo, createSignal, Show } from "solid-js";
import { CloseX } from "./CloseX";
import {
  C,
  overlayStyle as baseOverlay,
  dialogStyle as baseDialog,
  inputStyle,
  btnPrimary,
  btnSecondary,
  btnDanger,
} from "../theme";

interface Props {
  initial: string | null;
  onSave: (color: string | null) => void;
  onClose: () => void;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lN - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
      case g: h = ((b - r) / d + 2) * 60; break;
      case b: h = ((r - g) / d + 4) * 60; break;
    }
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function ColorPickerDialog(props: Props) {
  const seed = props.initial ? hexToHsl(props.initial) : null;
  const [h, setH] = createSignal(seed?.h ?? 210);
  const [s, setS] = createSignal(seed?.s ?? 75);
  const [l, setL] = createSignal(seed?.l ?? 55);
  const [hexInput, setHexInput] = createSignal(props.initial ?? hslToHex(210, 75, 55));

  const current = createMemo(() => hslToHex(h(), s(), l()));

  function syncFromHex(raw: string) {
    setHexInput(raw);
    const parsed = hexToHsl(raw);
    if (parsed) {
      setH(parsed.h);
      setS(parsed.s);
      setL(parsed.l);
    }
  }

  function onSliderChange(setter: (n: number) => void, max: number) {
    return (e: InputEvent) => {
      const v = clamp(parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0, 0, max);
      setter(v);
      setHexInput(current());
    };
  }

  function save() {
    props.onSave(current());
    props.onClose();
  }

  function clear() {
    props.onSave(null);
    props.onClose();
  }

  return (
    <div style={overlay} onClick={props.onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <strong style={{ "font-size": "15px", "padding-right": "32px", display: "block" }}>
          🎨 Customize tab color
        </strong>
        <div style={{ "font-size": "12px", opacity: 0.65, "margin": "6px 0 16px" }}>
          Pick any color using the sliders or paste a hex value.
        </div>

        <div style={previewRow}>
          <div
            style={{
              ...previewSwatch,
              background: current(),
              "box-shadow": `0 0 24px ${current()}66`,
            }}
          />
          <div style={previewTab}>
            <div
              style={{
                ...previewTabInner,
                background: `linear-gradient(90deg, ${current()}26 0%, ${current()}0d 60%, transparent 100%)`,
                "border-left": `3px solid ${current()}`,
              }}
            >
              <span style={{ color: current(), "font-weight": 600 }}>●</span>
              <span>Sample tab</span>
            </div>
          </div>
        </div>

        <div style={sliderGrid}>
          <label style={lbl}>Hue</label>
          <input
            type="range"
            min="0"
            max="360"
            value={h()}
            onInput={onSliderChange(setH, 360)}
            style={{ ...sliderInput, background: hueGradient }}
          />
          <span style={val}>{h()}°</span>

          <label style={lbl}>Saturation</label>
          <input
            type="range"
            min="0"
            max="100"
            value={s()}
            onInput={onSliderChange(setS, 100)}
            style={{
              ...sliderInput,
              background: `linear-gradient(90deg, ${hslToHex(h(), 0, l())}, ${hslToHex(h(), 100, l())})`,
            }}
          />
          <span style={val}>{s()}%</span>

          <label style={lbl}>Lightness</label>
          <input
            type="range"
            min="10"
            max="90"
            value={l()}
            onInput={onSliderChange(setL, 100)}
            style={{
              ...sliderInput,
              background: `linear-gradient(90deg, #000, ${hslToHex(h(), s(), 50)}, #fff)`,
            }}
          />
          <span style={val}>{l()}%</span>
        </div>

        <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-top": "14px" }}>
          <label style={{ ...lbl, "min-width": "auto" }}>Hex</label>
          <input
            value={hexInput()}
            onInput={(e) => syncFromHex(e.currentTarget.value)}
            placeholder="#aabbcc"
            style={{ ...inputStyle, "font-family": "monospace", flex: 1 }}
          />
        </div>

        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end", "margin-top": "18px" }}>
          <Show when={props.initial}>
            <button onClick={clear} style={btnDanger}>Clear</button>
          </Show>
          <button onClick={props.onClose} style={btnSecondary}>Cancel</button>
          <button onClick={save} style={btnPrimary}>Save</button>
        </div>

        <CloseX onClose={props.onClose} />
      </div>
    </div>
  );
}

const hueGradient =
  "linear-gradient(90deg,#ff0000 0%,#ffff00 17%,#00ff00 33%,#00ffff 50%,#0000ff 67%,#ff00ff 83%,#ff0000 100%)";

const overlay = { ...baseOverlay, "z-index": "160" } as const;

const dialog = {
  ...baseDialog,
  "min-width": "420px",
  "max-width": "480px",
} as const;

const previewRow = {
  display: "flex",
  "align-items": "center",
  gap: "14px",
  "margin-bottom": "16px",
} as const;

const previewSwatch = {
  width: "56px",
  height: "56px",
  "border-radius": "12px",
  border: `1px solid ${C.border}`,
  "flex-shrink": 0,
} as const;

const previewTab = {
  flex: 1,
  background: C.bg2,
  "border-radius": "8px",
  padding: "4px",
} as const;

const previewTabInner = {
  display: "flex",
  "align-items": "center",
  gap: "8px",
  padding: "8px 10px",
  "border-radius": "6px",
  "font-size": "12px",
  color: C.text,
} as const;

const sliderGrid = {
  display: "grid",
  "grid-template-columns": "72px 1fr 48px",
  "align-items": "center",
  gap: "8px 10px",
} as const;

const lbl = {
  "font-size": "12px",
  color: C.text2,
  "min-width": "60px",
} as const;

const val = {
  "font-size": "11px",
  color: C.text3,
  "font-family": "monospace",
  "text-align": "right" as const,
} as const;

const sliderInput = {
  appearance: "none" as const,
  "-webkit-appearance": "none" as const,
  height: "10px",
  "border-radius": "5px",
  outline: "none",
  cursor: "pointer",
} as const;
