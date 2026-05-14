import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import { C } from "../theme";
import {
  activeTabId,
  tabs,
  type Tab,
  type TabStatus,
} from "../stores/tabs";
import { closeExpose, startZoom, zoomingTabId } from "../stores/expose";

interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  /** Natural (pre-scale) size each terminal renders at — the size of the
   *  main pane before Exposé opened. Used by App.tsx to compute per-cell
   *  scale factors. */
  natural: { w: number; h: number };
  /** Reports per-tab cell rects in viewport coordinates back to App.tsx so
   *  the terminal wrappers (rendered outside this overlay) can position
   *  themselves into each cell. */
  onCellRects: (rects: Map<string, CellRect>) => void;
  /** Called when a tab is selected. App.tsx orchestrates the zoom animation
   *  before closing the overlay. */
  onActivate: (tabId: string) => void;
}

const statusColor: Record<TabStatus, string> = {
  connecting: C.yellow,
  connected: C.green,
  disconnected: C.text3,
  error: C.red,
};

const statusGlyph: Record<TabStatus, string> = {
  connecting: "◐",
  connected: "●",
  disconnected: "○",
  error: "!",
};

export function ExposeView(props: Props) {
  let gridRef: HTMLDivElement | undefined;
  const cellRefs = new Map<string, HTMLDivElement>();

  function recomputeRects() {
    const rects = new Map<string, CellRect>();
    for (const [id, el] of cellRefs) {
      const r = el.getBoundingClientRect();
      rects.set(id, { x: r.left, y: r.top, w: r.width, h: r.height });
    }
    props.onCellRects(rects);
  }

  // Recompute on mount, on resize, and when tabs change (For mounts/unmounts cells).
  onMount(() => {
    queueMicrotask(recomputeRects);
    const ro = new ResizeObserver(recomputeRects);
    if (gridRef) ro.observe(gridRef);
    window.addEventListener("resize", recomputeRects);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", recomputeRects);
    });
  });

  // Re-report rects whenever the tab list changes.
  createEffect(() => {
    void tabs().length;
    queueMicrotask(recomputeRects);
  });

  // Esc to dismiss. Background click handled on the backdrop div.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeExpose();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function activate(id: string) {
    if (zoomingTabId()) return; // already animating
    startZoom(id);
    props.onActivate(id);
  }

  return (
    <div
      style={{
        ...backdropStyle,
        opacity: zoomingTabId() ? 0 : 1,
        transition: "opacity 0.22s ease",
      }}
      onClick={(e) => {
        if (zoomingTabId()) return;
        if (e.target === e.currentTarget) closeExpose();
      }}
    >
      <div ref={gridRef} style={gridStyle}>
        <For each={tabs()}>
          {(t: Tab, i) => {
            const isActive = () => t.id === activeTabId();
            const isZooming = () => zoomingTabId() === t.id;
            const otherZooming = () =>
              zoomingTabId() !== null && zoomingTabId() !== t.id;
            const [appeared, setAppeared] = createSignal(false);
            onMount(() => {
              setTimeout(() => setAppeared(true), i() * 30);
            });
            return (
              <div
                ref={(el) => {
                  cellRefs.set(t.id, el);
                  onCleanup(() => cellRefs.delete(t.id));
                }}
                style={{
                  position: "relative",
                  "aspect-ratio": `${props.natural.w} / ${props.natural.h}`,
                  // Transparent: the live terminal (rendered at z-index 110
                  // via fixed positioning) shows through. We only draw the
                  // border, shadow, and label bar on top.
                  background: "transparent",
                  border: `2px solid ${
                    isActive() || isZooming() ? C.accent : C.border
                  }`,
                  "border-radius": "10px",
                  cursor: zoomingTabId() ? "default" : "pointer",
                  "box-shadow": "0 8px 32px rgba(0,0,0,0.5)",
                  opacity: otherZooming() ? 0 : appeared() ? 1 : 0,
                  transform: appeared() ? "translateY(0)" : "translateY(12px)",
                  transition:
                    "transform 0.22s ease, border-color 0.15s ease, opacity 0.22s ease",
                  // Above the terminal wrapper (z-index 110) so the cell
                  // (border + label + click capture) sits in front.
                  "z-index": "120",
                }}
                onMouseEnter={(e) => {
                  if (zoomingTabId()) return;
                  if (!isActive()) {
                    (e.currentTarget as HTMLElement).style.borderColor = C.accentBdr;
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    isActive() ? C.accent : C.border;
                }}
                onClick={() => activate(t.id)}
              >
                {/* Label bar overlaid on top of the (rendered-behind) terminal */}
                <div style={labelBarStyle}>
                  <span style={{ color: statusColor[t.status], "font-size": "10px" }}>
                    {statusGlyph[t.status]}
                  </span>
                  {t.icon && <span>{t.icon}</span>}
                  <span style={{
                    color: t.color ?? C.text,
                    "font-weight": 600,
                    "white-space": "nowrap",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "flex-grow": 1,
                  }}>
                    {t.name}
                  </span>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

const backdropStyle = {
  position: "fixed",
  inset: "0",
  background: "rgba(11,11,15,0.85)",
  "backdrop-filter": "blur(20px)",
  "z-index": "100",
  overflow: "auto",
} as const;

const gridStyle = {
  display: "grid",
  gap: "24px",
  padding: "48px",
  "grid-template-columns": "repeat(auto-fit, minmax(320px, 1fr))",
  "min-height": "100%",
  "box-sizing": "border-box",
  "align-content": "start",
} as const;

const labelBarStyle = {
  position: "absolute",
  top: "0",
  left: "0",
  right: "0",
  display: "flex",
  "align-items": "center",
  gap: "6px",
  padding: "6px 10px",
  background: "linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0))",
  color: C.text,
  "font-size": "12px",
  "z-index": "1",
  "pointer-events": "none" as const,
} as const;
