import { createEffect, createSignal, For, Show } from "solid-js";

const MIN_W = 140;
const MAX_W = 400;
import { C } from "../theme";
import {
  activeTabId,
  closeTab,
  dumpTabBuffer,
  openMarkCwd,
  renameTab,
  reorderTabs,
  setActiveTab,
  setTabColor,
  setTabIcon,
  tabs,
  toggleTabPassthrough,
  type Tab,
  type TabStatus,
} from "../stores/tabs";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ColorPickerDialog } from "./ColorPickerDialog";
import { api } from "../ipc/api";

/** Convert a hex color to rgba with the given alpha. Falls back to transparent
 *  if parsing fails so a bad value never breaks the tab render. */
function hexToRgba(hex: string | null | undefined, alpha: number): string {
  if (!hex) return "transparent";
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}

interface Props {
  onNew: () => void;
  width: number;
  mode: "split" | "hover";
  visible: boolean;
  autoHide: boolean;
  onShow: () => void;
  onHide: () => void;
  onWidthChange: (width: number) => void;
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

/** 4×4 palette of preset tab colors. Tuned to read clearly on the dark
 *  macOS-style background; each row roughly groups warm → cool → neutral. */
const PRESET_COLORS: { name: string; value: string }[] = [
  { name: "Red",       value: "#ff453a" },
  { name: "Coral",     value: "#ff6f61" },
  { name: "Orange",    value: "#ff9f0a" },
  { name: "Amber",     value: "#ffb340" },

  { name: "Yellow",    value: "#ffd60a" },
  { name: "Lime",      value: "#9beb52" },
  { name: "Green",     value: "#30d158" },
  { name: "Teal",      value: "#40c8c0" },

  { name: "Cyan",      value: "#5ac8fa" },
  { name: "Sky",       value: "#64d2ff" },
  { name: "Blue",      value: "#0a84ff" },
  { name: "Indigo",    value: "#5e5ce6" },

  { name: "Purple",    value: "#bf5af2" },
  { name: "Magenta",   value: "#ff2d92" },
  { name: "Pink",      value: "#ff8aa8" },
  { name: "Graphite",  value: "#9aa0a6" },
];

const ICONS = [
  { name: "None", value: null },
  { name: "🤖 Robot", value: "🤖" },
  { name: "🚀 Rocket", value: "🚀" },
  { name: "🐧 Linux", value: "🐧" },
  { name: "🔧 Tool", value: "🔧" },
  { name: "📦 Box", value: "📦" },
  { name: "⭐ Star", value: "⭐" },
  { name: "🔥 Fire", value: "🔥" },
];

function shortCwd(p: string): string {
  if (p.length <= 28) return p;
  return "…" + p.slice(p.length - 27);
}

export function TabBar(props: Props) {
  const [tabBarWidth, setTabBarWidth] = createSignal(props.width);
  const [menu, setMenu] = createSignal<{ x: number; y: number; tab: Tab } | null>(null);
  const [pickerTabId, setPickerTabId] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [hoveredTabId, setHoveredTabId] = createSignal<string | null>(null);
  const [resizing, setResizing] = createSignal(false);
  /** Tab id under cursor (or "__end__"). Null when not over any drop target. */
  const [dropTargetId, setDropTargetId] = createSignal<string | null>(null);
  const isHoverMode = () => props.mode === "hover";

  createEffect(() => {
    setTabBarWidth(clampWidth(props.width));
  });

  function startResize(ev: MouseEvent) {
    ev.preventDefault();
    setResizing(true);
    const startX = ev.clientX;
    const startW = tabBarWidth();
    let nextW = startW;
    const onMove = (e: MouseEvent) =>
      setTabBarWidth((nextW = clampWidth(startW + (e.clientX - startX))));
    const onUp = () => {
      setResizing(false);
      props.onWidthChange(nextW);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /** Pointer-event-based drag. HTML5 drag-and-drop is unreliable in WebView2 —
   *  events frequently don't fire, so we hand-roll it with mousedown/move/up. */
  function startDrag(ev: MouseEvent, tabId: string) {
    if (ev.button !== 0) return;
    if (renamingId() === tabId) return;
    // Don't start drag if user clicked the close × or the rename input.
    const target = ev.target as HTMLElement;
    if (target.tagName === "BUTTON" || target.tagName === "INPUT") return;

    const startX = ev.clientX;
    const startY = ev.clientY;
    let active = false; // becomes true after threshold

    const onMove = (e: MouseEvent) => {
      if (!active) {
        // 4px threshold so quick clicks aren't misread as drags
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        active = true;
        setDraggingId(tabId);
      }
      // Find which tab the cursor is currently over.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const slot = el?.closest("[data-tab-slot]");
      setDropTargetId(slot?.getAttribute("data-tab-slot") ?? null);
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = dropTargetId();
      if (active && target && target !== tabId) {
        reorderTabs(tabId, target === "__end__" ? null : target);
      }
      setDraggingId(null);
      setDropTargetId(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function openMenu(e: MouseEvent, tab: Tab) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tab });
  }

  function buildMenu(tab: Tab): MenuItem[] {
    return [
      { label: "Rename (F2)", onClick: () => setRenamingId(tab.id) },
      {
        label: tab.cwd ? `📍 Edit cwd (${shortCwd(tab.cwd)})` : "📍 Mark cwd…",
        onClick: () => openMarkCwd(tab.id),
      },
      {
        label: tab.passthrough ? "🤖 Disable passthrough" : "🤖 Enable passthrough",
        onClick: () => toggleTabPassthrough(tab.id),
      },
      {
        label: "Color",
        swatch: tab.color ?? null,
        customSubmenu: (close) => (
          <ColorPaletteGrid
            current={tab.color ?? null}
            onPick={(c) => {
              setTabColor(tab.id, c);
              close();
            }}
            onCustomize={() => {
              setPickerTabId(tab.id);
              close();
            }}
          />
        ),
      },
      {
        label: "Icon",
        submenu: ICONS.map((ic) => ({
          label: ic.name + (tab.icon === ic.value ? "  ✓" : ""),
          onClick: () => setTabIcon(tab.id, ic.value),
        })),
      },
      { separator: true, label: "" },
      { label: "📝 Export transcript…", onClick: () => exportTranscript(tab) },
      { separator: true, label: "" },
      { label: "Close", danger: true, onClick: () => closeTab(tab.id) },
    ];
  }

  async function exportTranscript(tab: Tab) {
    const text = dumpTabBuffer(tab.id);
    if (text === null) {
      console.warn("no buffer dumper registered for", tab.id);
      return;
    }
    // Header lets the file stand on its own when shared.
    const header = [
      `# BOOKSHELL transcript`,
      `# tab:    ${tab.name}`,
      `# cwd:    ${tab.cwd ?? "(unset)"}`,
      `# saved:  ${new Date().toISOString()}`,
      ``,
      ``,
    ].join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = tab.name.replace(/[^\w.-]+/g, "_") || "tab";
    const suggested = `bookshell-${safeName}-${stamp}.txt`;
    try {
      await api.transcriptSaveDialog(suggested, header + text + "\n");
    } catch (e) {
      console.warn("transcript save failed", e);
    }
  }

  function commitRename(tabId: string, ev: HTMLInputElement) {
    renameTab(tabId, ev.value);
    setRenamingId(null);
  }

  return (
    <div
      onMouseEnter={props.onShow}
      onMouseLeave={() => { if (props.autoHide) props.onHide(); }}
      style={{
        display: "flex",
        width: isHoverMode() || props.visible ? `${tabBarWidth()}px` : "0px",
        height: "100%",
        "flex-shrink": 0,
        position: isHoverMode() ? "absolute" : "relative",
        top: isHoverMode() ? "0" : undefined,
        bottom: isHoverMode() ? "0" : undefined,
        left: isHoverMode() ? "0" : undefined,
        "z-index": isHoverMode() ? 8 : undefined,
        transform: props.visible ? "translateX(0)" : "translateX(calc(-100% - 8px))",
        transition: "width 0.18s ease, transform 0.18s ease",
        "pointer-events": props.visible ? "auto" : "none",
        overflow: "hidden",
        "box-shadow": isHoverMode() && props.visible ? "12px 0 36px rgba(0,0,0,0.35)" : "none",
      }}
    >
    <div style={{ ...containerStyle, ...(isHoverMode() ? acrylicContainerStyle : {}) }}>
      <For each={tabs()}>
        {(t) => (
          <div
            data-tab-slot={t.id}
            onMouseDown={(e) => startDrag(e, t.id)}
            onClick={() => setActiveTab(t.id)}
            onDblClick={() => setRenamingId(t.id)}
            onContextMenu={(e) => openMenu(e, t)}
            onMouseEnter={() => setHoveredTabId(t.id)}
            onMouseLeave={() => setHoveredTabId((id) => id === t.id ? null : id)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "F2" && t.id === activeTabId()) {
                e.preventDefault();
                setRenamingId(t.id);
              }
            }}
            tabindex={t.id === activeTabId() ? 0 : -1}
            style={{
              ...tabStyle,
              ...tabColorStyle(t.color, t.id === activeTabId(), hoveredTabId() === t.id),
              opacity: draggingId() === t.id ? 0.35 : 1,
              "border-top": dropTargetId() === t.id && draggingId() && draggingId() !== t.id
                ? `2px solid ${C.accent}`
                : "2px solid transparent",
            }}
            title={t.errorMessage ?? t.name}
          >
          <div style={tabTopRowStyle}>
            <span style={{ color: statusColor[t.status], "font-size": "10px", width: "12px" }}>
              {statusGlyph[t.status]}
            </span>
            <Show when={t.passthrough}>
              <span title="AI passthrough on" style={{ "font-size": "11px" }}>🤖</span>
            </Show>
            <Show when={t.cwd}>
              <span title={`cwd: ${t.cwd}`} style={{ "font-size": "10px" }}>📍</span>
            </Show>
            <Show when={t.icon}>{(ic) => <span>{ic()}</span>}</Show>
            <Show
              when={renamingId() === t.id}
              fallback={
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                    color: t.color
                      ? (t.id === activeTabId() ? t.color : hexToRgba(t.color, 0.85))
                      : C.text,
                    "font-weight": t.color && t.id === activeTabId() ? 600 : 400,
                  }}
                >
                  {t.name}
                </span>
              }
            >
              <input
                value={t.name}
                autofocus
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onBlur={(e) => commitRename(t.id, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(t.id, e.currentTarget);
                  if (e.key === "Escape") setRenamingId(null);
                  e.stopPropagation();
                }}
                style={renameInputStyle}
              />
            </Show>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              style={closeBtnStyle}
              title="Close (Ctrl+Shift+W)"
            >
              ×
            </button>
          </div>
          <Show when={t.cwd}>
            <div style={cwdRowStyle}>
              {shortCwd(t.cwd!)}
            </div>
          </Show>
          </div>
        )}
      </For>
      <div
        data-tab-slot="__end__"
        style={{
          "min-height": "12px",
          "border-top": dropTargetId() === "__end__" && draggingId()
            ? `2px solid ${C.accent}`
            : "2px solid transparent",
        }}
      />
      <button onClick={props.onNew} style={newBtnStyle} title="New tab (Ctrl+Shift+T)">
        + New
      </button>

      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            items={buildMenu(m().tab)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>

      <Show when={pickerTabId()}>
        {(id) => {
          const t = tabs().find((x) => x.id === id());
          return (
            <ColorPickerDialog
              initial={t?.color ?? null}
              onSave={(c) => setTabColor(id(), c)}
              onClose={() => setPickerTabId(null)}
            />
          );
        }}
      </Show>
    </div>
    {/* right-edge drag handle */}
    <div
      onMouseDown={startResize}
      style={{
        width: "4px",
        cursor: "col-resize",
        background: resizing() ? C.accent : "transparent",
        "border-right": `1px solid ${C.border}`,
        "flex-shrink": 0,
        transition: "background 0.15s",
      }}
      title="Drag to resize"
    />
    </div>
  );
}

function clampWidth(w: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(w || 190)));
}

const containerStyle = {
  flex: 1,
  background: C.bg2,
  display: "flex",
  "flex-direction": "column",
  padding: "6px 4px",
  gap: "1px",
  "overflow-y": "auto",
  "min-width": 0,
} as const;

const acrylicContainerStyle = {
  background: "rgba(28,28,30,0.62)",
  "backdrop-filter": "blur(24px) saturate(180%)",
  "-webkit-backdrop-filter": "blur(24px) saturate(180%)",
  border: `1px solid ${C.border}`,
  "border-left": "none",
} as const;

const tabStyle = {
  display: "flex",
  "flex-direction": "column",
  padding: "5px 8px",
  "border-radius": "6px",
  cursor: "grab",
  "font-size": "12px",
  color: C.text,
  "user-select": "none",
  position: "relative" as const,
  transition: "background 0.12s ease",
} as const;

/** Build the dynamic part of a tab's style: a flat solid tint of the chosen
 *  color across the whole tab. Active tabs get a slightly stronger alpha so
 *  they still stand out against their inactive siblings. */
function tabColorStyle(color: string | null | undefined, active: boolean, hovered: boolean) {
  if (!color) {
    return { background: active ? C.bgActive : hovered ? C.bgHover : "transparent" };
  }
  return { background: hexToRgba(color, active ? (hovered ? 0.38 : 0.32) : hovered ? 0.25 : 0.18) };
}

const tabTopRowStyle = {
  display: "flex",
  "align-items": "center",
  gap: "5px",
  width: "100%",
} as const;

const cwdRowStyle = {
  "font-size": "10px",
  color: C.text3,
  "white-space": "nowrap",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "padding-left": "17px",
  "margin-top": "2px",
} as const;

const renameInputStyle = {
  flex: 1,
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.accent}`,
  "border-radius": "4px",
  padding: "1px 5px",
  "font-size": "12px",
  outline: "none",
  "min-width": 0,
} as const;

const closeBtnStyle = {
  background: "transparent",
  color: C.text3,
  border: "none",
  cursor: "pointer",
  "font-size": "14px",
  padding: "0 3px",
  "line-height": "1",
  "flex-shrink": 0,
} as const;

const newBtnStyle = {
  background: "transparent",
  color: C.text3,
  border: `1px dashed ${C.borderSub}`,
  "border-radius": "6px",
  padding: "5px 8px",
  cursor: "pointer",
  "font-size": "12px",
  "margin-top": "4px",
  transition: "color 0.1s, border-color 0.1s",
} as const;

interface PaletteProps {
  current: string | null;
  onPick: (color: string | null) => void;
  onCustomize: () => void;
}

function ColorPaletteGrid(props: PaletteProps) {
  const isSelected = (v: string | null) =>
    (props.current ?? null)?.toLowerCase() === (v ?? null)?.toLowerCase();

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "10px", "min-width": "188px" }}>
      <div style={{ display: "grid", "grid-template-columns": "repeat(4, 36px)", gap: "6px" }}>
        <For each={PRESET_COLORS}>
          {(c) => (
            <button
              title={c.name}
              onClick={() => props.onPick(c.value)}
              style={{
                width: "36px",
                height: "36px",
                "border-radius": "8px",
                border: isSelected(c.value)
                  ? `2px solid ${C.text}`
                  : `1px solid rgba(255,255,255,0.08)`,
                background: c.value,
                cursor: "pointer",
                padding: 0,
                "box-shadow": isSelected(c.value)
                  ? `0 0 0 2px rgba(0,0,0,0.4), 0 0 12px ${c.value}80`
                  : "inset 0 1px 0 rgba(255,255,255,0.15)",
                transition: "transform 0.08s ease, box-shadow 0.15s",
              }}
              onMouseOver={(e) => (e.currentTarget.style.transform = "scale(1.08)")}
              onMouseOut={(e) => (e.currentTarget.style.transform = "scale(1)")}
            />
          )}
        </For>
      </div>

      <div style={{ display: "flex", gap: "6px" }}>
        <button
          onClick={() => props.onPick(null)}
          style={{
            flex: 1,
            background: isSelected(null) ? C.bgActive : "transparent",
            color: C.text,
            border: `1px solid ${C.border}`,
            "border-radius": "6px",
            padding: "6px 8px",
            "font-size": "12px",
            cursor: "pointer",
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = C.bgHover)}
          onMouseOut={(e) =>
            (e.currentTarget.style.background = isSelected(null) ? C.bgActive : "transparent")
          }
        >
          Default
        </button>
        <button
          onClick={() => props.onCustomize()}
          style={{
            flex: 1,
            background: "transparent",
            color: C.text,
            border: `1px solid ${C.border}`,
            "border-radius": "6px",
            padding: "6px 8px",
            "font-size": "12px",
            cursor: "pointer",
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = C.bgHover)}
          onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
        >
          🎨 Customize…
        </button>
      </div>
    </div>
  );
}
