import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { C } from "../theme";
import {
  activeTabId,
  tabs,
  type Tab,
  type TabStatus,
} from "../stores/tabs";
import { closeExpose, startZoom, zoomingTabId } from "../stores/expose";
import { tabBgFor, tabFgFor } from "./TabBar";

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
  // Local copy of cell rects so the label overlay (rendered through a Portal
  // at root, above the live terminal preview at z-index 110) can position
  // itself against each cell. Labels can't live inside the cell because the
  // cell's z-index 120 is local to the backdrop's stacking context (z=100),
  // which would render the label under the terminal wrapper.
  const [rects, setRects] = createSignal<Map<string, CellRect>>(new Map());

  function recomputeRects() {
    const next = new Map<string, CellRect>();
    for (const [id, el] of cellRefs) {
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left, y: r.top, w: r.width, h: r.height });
    }
    setRects(next);
    props.onCellRects(next);
  }

  // Recompute on mount, on resize, and when tabs change. rAF (not
  // queueMicrotask) so the browser has run a layout pass — cells using
  // `aspect-ratio` + `grid-template-columns: auto-fit minmax(...)` don't
  // resolve their final size until after layout, and microtasks fire
  // before that.
  onMount(() => {
    requestAnimationFrame(recomputeRects);
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
    requestAnimationFrame(recomputeRects);
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
              />
            );
          }}
        </For>
      </div>

      {/* Bottom labels rendered through a Portal so they paint above the live
          terminal preview (which is at fixed z-index 110, escaping ExposeView's
          z=100 stacking context). Each label tracks its cell's rect. */}
      <Portal>
        <For each={tabs()}>
          {(t: Tab) => {
            const r = () => rects().get(t.id);
            return (
              <Show when={r()}>
                {(rect) => {
                  const active = () => t.id === activeTabId();
                  return (
                    <div
                      style={{
                        position: "fixed",
                        left: `${rect().x + 10}px`,
                        width: `${Math.max(0, rect().w - 20)}px`,
                        top: `${rect().y + rect().h - 40}px`,
                        display: "flex",
                        "align-items": "center",
                        gap: "6px",
                        padding: "7px 12px",
                        // Mirror the left tab bar exactly: solid tint of the
                        // tab's color (or bgActive / transparent when no
                        // colour) so a quick glance reads the same on both
                        // surfaces.
                        background: tabBgFor(t.color, active(), false),
                        border: `1px solid ${C.border}`,
                        "border-radius": "8px",
                        "box-shadow": "0 4px 14px rgba(0,0,0,0.45)",
                        color: tabFgFor(t.color, active()),
                        "font-size": "13px",
                        "font-weight": t.color && active() ? 600 : 400,
                        "z-index": 200,
                        "pointer-events": "none",
                        opacity: zoomingTabId() && zoomingTabId() !== t.id ? 0 : 1,
                        transition: "opacity 0.22s ease, top 0.22s ease, left 0.22s ease, width 0.22s ease",
                      }}
                    >
                      <span style={{ color: statusColor[t.status], "font-size": "10px" }}>
                        {statusGlyph[t.status]}
                      </span>
                      {t.icon && <span>{t.icon}</span>}
                      <span style={{
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "flex-grow": 1,
                      }}>
                        {t.name}
                      </span>
                    </div>
                  );
                }}
              </Show>
            );
          }}
        </For>
      </Portal>
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

