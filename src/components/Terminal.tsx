import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { ansiPaletteColor, C, xtermTheme } from "../theme";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../ipc/api";
import {
  bumpFit,
  onTabBufferDump,
  onTabClose,
  onTabData,
  onTabPreview,
  type PreviewRun,
  type Tab,
} from "../stores/tabs";
import { closeSearch, isSearchOpenFor } from "../stores/search";
import { general, terminalFontFamily } from "../stores/general";
import { connections, isLinux } from "../stores/connections";
import { connectTab, reconnectTabFromProfile, restoreCwd } from "../stores/tabs";

interface Props {
  tab: Tab;
  active: boolean;
  /** When set, the terminal renders at `naturalW x naturalH` CSS pixels and
   *  is visually shrunk via `transform: scale(scale)`. Used by Mission
   *  Control (Exposé) grid so the PTY/xterm never sees a resize. Positioned
   *  at `(cellX, cellY)` in viewport coordinates (page-fixed). */
  gridLayout?: {
    cellX: number;
    cellY: number;
    naturalW: number;
    naturalH: number;
    scale: number;
  } | null;
}

interface MatchInfo {
  resultIndex: number;
  resultCount: number;
}

export function TerminalView(props: Props) {
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let highlightAddons: Array<SearchAddon | undefined> = [];
  let searchInputRef: HTMLInputElement | undefined;
  let fitRaf = 0;

  const [query, setQuery] = createSignal("");
  const [pwPrompt, setPwPrompt] = createSignal("");
  const [reconnecting, setReconnecting] = createSignal(false);
  const [dragOver, setDragOver] = createSignal<"local" | "blocked" | null>(null);
  const [uploading, setUploading] = createSignal(false);
  const [showHighlight, setShowHighlight] = createSignal(false);

  interface HighlightSlot { color: string; keyword: string; }
  const DEFAULT_HIGHLIGHT_COLORS = ["#ff453a", "#ffd60a", "#30d158", "#0a84ff", "#bf5af2"];
  const [slots, setSlots] = createStore<HighlightSlot[]>(
    DEFAULT_HIGHLIGHT_COLORS.map((color) => ({ color, keyword: "" })),
  );
  // Reactive flag flipped at the end of onMount. Effects that need a live
  // `term` instance must depend on this — SolidJS runs createEffect bodies
  // before onMount callbacks, so reading `term` directly in an effect's
  // first pass would see undefined.
  const [termReady, setTermReady] = createSignal(false);

  const profile = () =>
    connections().find((c) => c.id === props.tab.connectionId) ?? null;
  const showReconnectPanel = () =>
    props.tab.status === "disconnected" || props.tab.status === "error";

  async function doReconnect() {
    setReconnecting(true);
    try {
      const ok = await reconnectTabFromProfile(props.tab.id);
      if (!ok) {
        // No saved password — fall through to manual prompt below.
        return;
      }
    } catch (e) {
      console.error(e);
    } finally {
      setReconnecting(false);
    }
  }

  async function doManualReconnect() {
    const p = profile();
    if (!p) return;
    setReconnecting(true);
    try {
      await connectTab(props.tab.id, {
        host: p.host,
        port: p.port,
        user: p.user,
        password: pwPrompt(),
        cols: 80,
        rows: 24,
      });
      setPwPrompt("");
      restoreCwd(props.tab.id).catch(() => {});
    } catch (e) {
      console.error(e);
    } finally {
      setReconnecting(false);
    }
  }
  const [opts, setOpts] = createSignal<ISearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [matches, setMatches] = createSignal<MatchInfo>({ resultIndex: -1, resultCount: 0 });

  function buildOpts(): ISearchOptions {
    return {
      ...opts(),
      decorations: {
        matchBackground: "#515b78",
        matchOverviewRuler: "#f9e2af",
        activeMatchBackground: "#a06c2c",
        activeMatchColorOverviewRuler: "#fab387",
      },
    };
  }

  function runSearch(direction: "next" | "prev" = "next") {
    const q = query();
    if (!search) return;
    if (!q) {
      search.clearDecorations();
      setMatches({ resultIndex: -1, resultCount: 0 });
      return;
    }
    if (direction === "next") search.findNext(q, buildOpts());
    else search.findPrevious(q, buildOpts());
  }
  const findNext = () => runSearch("next");
  const findPrev = () => runSearch("prev");

  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      fit?.fit();
    });
  }

  function highlightAddonAt(index: number): SearchAddon | undefined {
    if (!term) return undefined;
    if (!highlightAddons[index]) {
      const addon = new SearchAddon();
      term.loadAddon(addon);
      highlightAddons[index] = addon;
    }
    return highlightAddons[index];
  }

  function applyHighlights() {
    slots.forEach((slot, i) => {
      const kw = slot.keyword.trim();
      const addon = kw ? highlightAddonAt(i) : highlightAddons[i];
      addon?.clearDecorations();
      if (!kw || !addon) return;
      addon.findNext(kw, {
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        decorations: {
          matchBackground: slot.color + "70",
          activeMatchBackground: slot.color + "70",
          matchOverviewRuler: slot.color,
          activeMatchColorOverviewRuler: slot.color,
        },
      });
    });
  }

  function clearHighlights() {
    highlightAddons.forEach((a) => a?.clearDecorations());
    DEFAULT_HIGHLIGHT_COLORS.forEach((color, i) => setSlots(i, { color, keyword: "" }));
  }

  // Build an xterm theme whose background respects the acrylic opacity. xterm
  // accepts CSS rgba strings here; combined with `allowTransparency: true`
  // the cell background composites over the translucent app surface.
  function themeForCurrent() {
    const g = general();
    const a = g.acrylic_enabled ? Math.max(0.1, Math.min(1, g.acrylic_opacity)) : 1;
    return { ...xtermTheme, background: `rgba(28,28,30,${a})` };
  }

  onMount(() => {
    term = new Terminal({
      cursorBlink: general().cursor_blink,
      fontFamily: terminalFontFamily(),
      fontSize: props.tab.fontSize ?? general().font_size,
      scrollback: general().scrollback,
      allowProposedApi: true,
      allowTransparency: true,
      theme: themeForCurrent(),
    });
    fit = new FitAddon();
    search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    highlightAddons = DEFAULT_HIGHLIGHT_COLORS.map(() => undefined);
    // Hand URL clicks off to the OS default browser via Tauri command — opening
    // them inside this WebView would navigate away from the app.
    term.loadAddon(
      new WebLinksAddon((_ev, uri) => {
        api.urlOpen(uri).catch((e) => console.warn("url_open failed", e));
      }),
    );
    try {
      term.loadAddon(new WebglAddon());
    } catch (e) {
      console.warn("WebGL addon failed", e);
    }
    term.open(host);
    fit.fit();

    // Some GUI hotkeys collide with xterm's keyboard handling — xterm would
    // otherwise swallow them in the capture phase and forward the ^x byte to
    // the shell. Returning false tells xterm to skip the event entirely so
    // it bubbles up to the window-level handler in App.tsx.
    //   Ctrl+F            — search
    //   Ctrl+Shift+E      — Mission Control / Exposé
    //   Ctrl(+Shift)+ +/-/=/0 — font size zoom (per-tab / global)
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") return false;
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") return false;
      if (e.ctrlKey && !e.altKey && (
        e.code === "Equal" || e.code === "Minus" || e.code === "Digit0" ||
        e.code === "NumpadAdd" || e.code === "NumpadSubtract" || e.code === "Numpad0"
      )) return false;
      return true;
    });

    // WebKitGTK + IME (fcitx5 chewing/pinyin/ibus) workaround: xterm's
    // composition handling on Linux WebKit emits the committed text twice
    // (once via compositionend, once via the trailing input event). Take over
    // IME entirely: write the composed text ourselves on compositionend and
    // swallow the bubble-phase listeners xterm registered on the textarea.
    {
      const ta = term.textarea as HTMLTextAreaElement | null;
      if (ta) {
        const ac = new AbortController();
        let endedAt = 0;
        ta.addEventListener("compositionend", (e) => {
          const ce = e as CompositionEvent;
          const text = ce.data && ce.data.length > 0 ? ce.data : ta.value;
          if (text) {
            const sid = props.tab.sessionId;
            if (sid) api.sshWrite(sid, text).catch(console.error);
          }
          ta.value = "";
          endedAt = performance.now();
          ce.stopImmediatePropagation();
        }, { capture: true, signal: ac.signal });
        ta.addEventListener("input", (ev) => {
          if (performance.now() - endedAt < 250) {
            ev.stopImmediatePropagation();
            ta.value = "";
          }
        }, { capture: true, signal: ac.signal });
        onCleanup(() => ac.abort());
      }
    }

    // Clipboard image paste. Two trigger paths:
    //
    // 1. Ctrl+V / Shift+Insert (paste event on textarea): skip if text is
    //    present; otherwise call the native backend which reads the image
    //    directly from the OS clipboard. The clipboardData.items check is
    //    intentionally omitted — WebKitGTK never surfaces image MIME types
    //    in ClipboardEvent.items, so we always let the Rust side decide.
    //
    // 2. Ctrl+Shift+V: explicit shortcut for the same path, useful when
    //    WebKitGTK doesn't fire a paste event for image-only clipboard content.
    //
    // In both cases: local tabs get the local /tmp path; SSH tabs have the
    // PNG uploaded to the remote /tmp first and get the remote path.
    // Returns true if an image was found and pasted, false if clipboard had no image.
    const pasteImage = async (): Promise<boolean> => {
      if (!props.active) return false;
      const conn = connections().find((c) => c.id === props.tab.connectionId);
      if (!conn) return false;
      const sid = props.tab.sessionId;
      const localPath = await api.clipboardSaveImage();
      if (!localPath) return false;
      if (conn.kind === "local") {
        term?.paste(quoteShellPath(localPath) + " ");
        term?.focus();
        return true;
      }
      if (!sid) return false;
      setUploading(true);
      try {
        const remotePath = await api.sshUploadFile(sid, localPath);
        term?.paste(quoteShellPath(remotePath) + " ");
        term?.focus();
        return true;
      } finally {
        setUploading(false);
      }
    };

    {
      const ta = term.textarea as HTMLTextAreaElement | null;
      if (ta) {
        const ac = new AbortController();
        ta.addEventListener(
          "paste",
          (e) => {
            const ev = e as ClipboardEvent;
            if (!props.active) return;
            const text = ev.clipboardData?.getData("text/plain") ?? "";
            if (text) return; // has text → let xterm handle normally
            ev.preventDefault();
            ev.stopImmediatePropagation();
            pasteImage().catch((err) =>
              console.warn("clipboard image paste failed", err),
            );
          },
          { capture: true, signal: ac.signal },
        );
        onCleanup(() => ac.abort());
      }
    }

    // Ctrl+Shift+V: paste image if clipboard has one, otherwise paste text.
    const onCtrlShiftV = async (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.key !== "V") return;
      if (!props.active) return;
      e.preventDefault();
      try {
        const didImage = await pasteImage();
        if (!didImage) {
          const text = await api.clipboardReadText();
          if (text) {
            term?.paste(text);
            term?.focus();
          }
        }
      } catch (err) {
        console.warn("clipboard paste failed", err);
      }
    };
    window.addEventListener("keydown", onCtrlShiftV);
    onCleanup(() => window.removeEventListener("keydown", onCtrlShiftV));

    search.onDidChangeResults((e) =>
      setMatches({ resultIndex: e.resultIndex, resultCount: e.resultCount }),
    );

    term.onData((data) => {
      const sid = props.tab.sessionId;
      if (sid) api.sshWrite(sid, data).catch(console.error);
    });

    term.onResize(({ cols, rows }) => {
      const sid = props.tab.sessionId;
      if (sid) api.sshResize(sid, cols, rows).catch(console.error);
    });

    onTabData(props.tab.id, (bytes) => term?.write(bytes));
    onTabClose(props.tab.id, (reason) => {
      term?.write(`\r\n\x1b[31m[session closed: ${reason}]\x1b[0m\r\n`);
    });

    // Walk the active buffer (scrollback + viewport) and return a plain-text
    // dump. xterm has already resolved every cursor move / line clear /
    // spinner redraw, so this is what the user actually saw on screen.
    onTabBufferDump(props.tab.id, () => {
      if (!term) return "";
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        lines.push(line ? line.translateToString(true) : "");
      }
      // Trim leading/trailing blanks; collapse 3+ consecutive blanks to 2.
      while (lines.length && lines[0] === "") lines.shift();
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const out: string[] = [];
      let blankRun = 0;
      for (const l of lines) {
        if (l === "") {
          blankRun++;
          if (blankRun <= 2) out.push(l);
        } else {
          blankRun = 0;
          out.push(l);
        }
      }
      return out.join("\n");
    });

    // Snapshot the current viewport as styled runs so the side bar's hover
    // preview popover can paint colors / bold the same way the live terminal
    // does. Coalesces adjacent cells with identical attributes into a single
    // run to keep the DOM cost roughly O(color-changes) rather than O(cells).
    onTabPreview(props.tab.id, () => {
      if (!term) return null;
      const buf = term.buffer.active;
      const start = buf.viewportY;
      const rows = term.rows;
      const lines: PreviewRun[][] = [];

      const cssFor = (
        isDefault: boolean,
        isRGB: boolean,
        value: number,
      ): string | undefined => {
        if (isDefault) return undefined;
        if (isRGB) {
          const r = (value >> 16) & 0xff;
          const g = (value >> 8) & 0xff;
          const b = value & 0xff;
          return `rgb(${r},${g},${b})`;
        }
        return ansiPaletteColor(value);
      };

      for (let y = start; y < start + rows; y++) {
        const line = buf.getLine(y);
        if (!line) { lines.push([]); continue; }
        const runs: PreviewRun[] = [];
        let pending: PreviewRun | null = null;
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell) continue;
          const chars = cell.getChars() || (cell.getWidth() === 0 ? "" : " ");
          if (!chars) continue;
          let fg = cssFor(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor());
          let bg = cssFor(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
          const bold = !!cell.isBold();
          // Inverse swaps fg/bg, with defaults filled in from the theme.
          if (cell.isInverse()) {
            const f = fg ?? xtermTheme.foreground;
            const b = bg ?? xtermTheme.background;
            fg = b;
            bg = f;
          }
          if (
            pending &&
            pending.fg === fg &&
            pending.bg === bg &&
            !!pending.bold === bold
          ) {
            pending.text += chars;
          } else {
            if (pending) runs.push(pending);
            pending = { text: chars, fg, bg, bold: bold || undefined };
          }
        }
        if (pending) runs.push(pending);
        // Strip the all-default trailing whitespace run so blank tails don't
        // waste popover width on giant " " spans.
        const last = runs[runs.length - 1];
        if (last && !last.fg && !last.bg && !last.bold) {
          last.text = last.text.replace(/\s+$/, "");
          if (!last.text) runs.pop();
        }
        lines.push(runs);
      }
      while (lines.length && lines[lines.length - 1].length === 0) lines.pop();
      return lines.length ? lines : null;
    });

    // Auto-copy on selection: fires when the drag ends inside the terminal.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return; // middle/right-click must not overwrite clipboard
      if (!term?.hasSelection()) return;
      const sel = term.getSelection();
      if (!sel) return;
      api.clipboardWriteText(sel).catch((e) =>
        console.warn("clipboard write failed", e),
      );
    };
    host.addEventListener("mouseup", onMouseUp);
    onCleanup(() => host.removeEventListener("mouseup", onMouseUp));

    // Ctrl+Shift+C: explicit copy shortcut. Covers the case where the drag
    // ends outside the terminal (tab bar, etc.) and mouseup didn't fire on
    // host. Uses native arboard to avoid WebKitGTK clipboard API hangs.
    const onCopyKey = (e: KeyboardEvent) => {
      if (!props.active || !e.ctrlKey || !e.shiftKey || e.altKey || e.key !== "C") return;
      if (!term?.hasSelection()) return;
      e.preventDefault();
      const sel = term.getSelection();
      if (!sel) return;
      api.clipboardWriteText(sel).catch((e) =>
        console.warn("clipboard write failed", e),
      );
    };
    window.addEventListener("keydown", onCopyKey);
    onCleanup(() => window.removeEventListener("keydown", onCopyKey));

    // Middle-click paste. On Linux, WebKitGTK handles X11 primary-selection
    // paste natively via onData — we only suppress the auto-scroll affordance
    // to avoid double-paste. On Windows/macOS there is no native primary
    // selection, so we read the clipboard manually with arboard.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (!isLinux()) {
        api.clipboardReadText().then((text) => {
          if (text) term?.paste(text);
        }).catch((err) => console.warn("middle-click paste failed", err));
      }
    };
    host.addEventListener("mousedown", onMouseDown);
    onCleanup(() => host.removeEventListener("mousedown", onMouseDown));

    const ro = new ResizeObserver(() => {
      // Skip fit in grid mode — the host's natural size is held constant via
      // `width/height: ${natural}px` styles and visually shrunk with a
      // transform, so we don't want xterm to reflow rows/cols (which would
      // signal a resize to the PTY).
      if (props.active && !props.gridLayout) scheduleFit();
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());

    // OS-level drag-drop. Tauri intercepts file drops before they reach the
    // webview, so HTML5 ondrop never fires — we have to subscribe to the
    // Tauri event stream instead. Each TerminalView registers its own
    // listener and gates on `props.active` so only the visible tab reacts.
    let dragUnlisten: UnlistenFn | undefined;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (!props.active) return;
        const conn = connections().find((c) => c.id === props.tab.connectionId);
        const isLocal = conn?.kind === "local";
        const t = ev.payload.type;
        if (t === "enter" || t === "over") {
          setDragOver(isLocal ? "local" : "blocked");
        } else if (t === "leave") {
          setDragOver(null);
        } else if (t === "drop") {
          setDragOver(null);
          if (!isLocal) return;
          const paths = ev.payload.paths ?? [];
          if (paths.length === 0) return;
          const text = paths.map(quoteShellPath).join(" ") + " ";
          term?.paste(text);
          term?.focus();
        }
      })
      .then((u) => {
        dragUnlisten = u;
      })
      .catch((e) => console.warn("onDragDropEvent failed", e));
    onCleanup(() => dragUnlisten?.());

    setTermReady(true);
  });

  // Refit when activated
  createEffect(() => {
    void props.tab.fitTick;
    if (props.active) {
      queueMicrotask(() => {
        scheduleFit();
        if (!isSearchOpenFor(props.tab.id)) term?.focus();
      });
    }
  });

  // Sync PTY size to xterm once a session is attached. The initial connect
  // call uses placeholder cols/rows (80x24), so the remote shell starts off
  // smaller than the visible viewport — leaving dead rows at the bottom that
  // PTY never writes to. xterm.onResize only fires on size *changes*, so it
  // can't catch up after the fact. Push the current dims explicitly here.
  // Depend on termReady so the effect re-runs once onMount has set up `term`.
  createEffect(() => {
    const sid = props.tab.sessionId;
    if (!sid || !termReady() || !term) return;
    requestAnimationFrame(() => {
      fit?.fit();
      if (term) api.sshResize(sid, term.cols, term.rows).catch(console.error);
    });
  });

  // Live-update term options when general settings change
  createEffect(() => {
    const g = general();
    const fontSize = props.tab.fontSize ?? g.font_size;
    const fontFamily = terminalFontFamily();
    if (!term) return;
    const geometryChanged =
      term.options.fontSize !== fontSize ||
      term.options.fontFamily !== fontFamily;
    term.options.scrollback = g.scrollback;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.theme = themeForCurrent();
    term.options.cursorBlink = g.cursor_blink;
    if (geometryChanged) scheduleFit();
  });

  // When ENTERING grid mode (Exposé), force a redraw of every terminal —
  // xterm-webgl skips draws while the element is hidden, so non-active tabs
  // would otherwise show a blank canvas. Refresh once per transition; not on
  // every gridLayout recompute (the layout object changes on window resize
  // / cell-rect updates and refresh() is not free).
  let gridWasOpen = false;
  createEffect(() => {
    const inGrid = !!props.gridLayout;
    if (inGrid && !gridWasOpen && term && !props.active) {
      requestAnimationFrame(() => {
        try { term?.refresh(0, term.rows - 1); } catch {}
      });
    }
    gridWasOpen = inGrid;
  });

  // When search opens for this tab, focus the input
  createEffect(() => {
    if (isSearchOpenFor(props.tab.id)) {
      queueMicrotask(() => searchInputRef?.focus());
    }
  });

  onCleanup(() => {
    if (fitRaf) cancelAnimationFrame(fitRaf);
    term?.dispose();
  });

  // Outer wrapper style switches between "stacked" (default — absolute,
  // visibility-toggled) and "grid" (fixed natural size, CSS-scaled). In
  // grid mode every terminal is visible at full pre-scale dimensions so
  // xterm-webgl keeps painting it; the scale is purely visual.
  const wrapperStyle = () => {
    const g = props.gridLayout;
    if (g) {
      // Border radius scales with the transform, so use a larger raw value
      // (in pre-scale pixels) to get ~10px visual rounding at typical scales.
      const radius = Math.round(10 / Math.max(g.scale, 0.0001));
      return {
        position: "fixed" as const,
        top: `${g.cellY}px`,
        left: `${g.cellX}px`,
        width: `${g.naturalW}px`,
        height: `${g.naturalH}px`,
        transform: `scale(${g.scale})`,
        "transform-origin": "top left",
        "pointer-events": "none" as const,
        // Above the backdrop, below the cell-click capture layer.
        "z-index": "110",
        // Rounded corners that match the cell frame (radius scaled to stay
        // visually constant after the scale transform).
        "border-radius": `${radius}px`,
        overflow: "hidden",
        // Smooth click-to-zoom: animates when gridLayout changes to a
        // full-pane rect (scale 1) before the overlay closes.
        transition: "top 0.22s ease, left 0.22s ease, transform 0.22s ease",
      };
    }
    return {
      position: "absolute" as const,
      inset: "0",
      visibility: (props.active ? "visible" : "hidden") as "visible" | "hidden",
      "pointer-events": (props.active ? "auto" : "none") as "auto" | "none",
    };
  };

  return (
    <div style={wrapperStyle()}>
      <div
        ref={host}
        style={{ position: "absolute", inset: "0", padding: "4px" }}
        onclick={() => {
          if (props.active && !props.gridLayout && !isSearchOpenFor(props.tab.id)) {
            term?.focus();
            bumpFit(props.tab.id);
          }
        }}
      />
      <Show when={showReconnectPanel()}>
        <div style={reconnectOverlay}>
          <div style={reconnectCard}>
            <div style={{ "font-size": "14px", "margin-bottom": "8px" }}>
              <span style={{ color: "#f9e2af" }}>●</span>{" "}
              {props.tab.status === "error" ? "Connection error" : "Disconnected"}
            </div>
            <Show when={props.tab.errorMessage}>
              <div style={{ "font-size": "12px", opacity: 0.7, "margin-bottom": "12px", "font-family": "monospace" }}>
                {props.tab.errorMessage}
              </div>
            </Show>
            <Show
              when={profile()}
              fallback={<div style={{ opacity: 0.6, "font-size": "13px" }}>Connection profile no longer exists.</div>}
            >
              {(p) => (
                <>
                  <div style={{ "margin-bottom": "12px", opacity: 0.8 }}>
                    {p().kind === "local"
                      ? `📟 local · ${p().shell ?? ""}`
                      : `${p().user}@${p().host}:${p().port}`}
                  </div>
                  <Show
                    when={p().kind === "local" || (p().password && p().password!.length > 0)}
                    fallback={
                      <div style={{ display: "flex", gap: "6px" }}>
                        <input
                          type="password"
                          placeholder="Password"
                          value={pwPrompt()}
                          autofocus
                          onInput={(e) => setPwPrompt(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") doManualReconnect();
                          }}
                          style={pwInput}
                          disabled={reconnecting()}
                        />
                        <button
                          onClick={doManualReconnect}
                          disabled={reconnecting() || !pwPrompt()}
                          style={primaryBtn}
                        >
                          {reconnecting() ? "Connecting…" : "Connect"}
                        </button>
                      </div>
                    }
                  >
                    <button
                      onClick={doReconnect}
                      disabled={reconnecting()}
                      style={primaryBtn}
                    >
                      {reconnecting() ? "Reconnecting…" : "↻ Reconnect"}
                    </button>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
      <Show when={dragOver()}>
        {(mode) => (
          <div style={dropOverlayStyle}>
            <div
              style={{
                ...dropCardStyle,
                color: mode() === "local" ? C.accent : C.text3,
                "border-color": mode() === "local" ? C.accent : C.border,
              }}
            >
              {mode() === "local"
                ? "📎 Drop to paste path"
                : "Drag-drop only supported on local connections"}
            </div>
          </div>
        )}
      </Show>
      <Show when={uploading()}>
        <div style={dropOverlayStyle}>
          <div
            style={{
              ...dropCardStyle,
              color: C.accent,
              "border-color": C.accent,
            }}
          >
            ⬆ Uploading image…
          </div>
        </div>
      </Show>
      <Show when={isSearchOpenFor(props.tab.id)}>
        <div style={searchBarStyle} onClick={(e) => e.stopPropagation()}>
          <input
            ref={searchInputRef}
            value={query()}
            placeholder="Find"
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              runSearch("next");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrev();
                else findNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
                term?.focus();
              }
            }}
            style={searchInputStyle}
          />
          <button
            onClick={() => {
              setOpts({ ...opts(), caseSensitive: !opts().caseSensitive });
              runSearch("next");
            }}
            style={toggleBtn(opts().caseSensitive)}
            title="Case sensitive"
          >
            Aa
          </button>
          <button
            onClick={() => {
              setOpts({ ...opts(), wholeWord: !opts().wholeWord });
              runSearch("next");
            }}
            style={toggleBtn(opts().wholeWord)}
            title="Whole word"
          >
            ab
          </button>
          <button
            onClick={() => {
              setOpts({ ...opts(), regex: !opts().regex });
              runSearch("next");
            }}
            style={toggleBtn(opts().regex)}
            title="Regex"
          >
            .*
          </button>
          <span style={{ "font-size": "12px", opacity: 0.7, "min-width": "60px", "text-align": "center" }}>
            {matches().resultCount > 0
              ? `${matches().resultIndex + 1} / ${matches().resultCount}`
              : query()
                ? "No match"
                : ""}
          </span>
          <button onClick={findPrev} style={navBtn} title="Previous (Shift+Enter)">▲</button>
          <button onClick={findNext} style={navBtn} title="Next (Enter)">▼</button>
          <button
            onClick={() => setShowHighlight((v) => !v)}
            style={toggleBtn(showHighlight())}
            title="Keyword highlight"
          >
            🎨
          </button>
          <button
            onClick={() => {
              closeSearch();
              term?.focus();
            }}
            style={navBtn}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      </Show>
      <Show when={showHighlight()}>
        <div style={highlightPanelStyle} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", "align-items": "center", "margin-bottom": "8px" }}>
            <span style={{ "font-size": "12px", "font-weight": 600, color: C.text }}>Keyword Highlight</span>
            <button onClick={() => setShowHighlight(false)} style={{ ...navBtn, "margin-left": "auto" }}>×</button>
          </div>
          <For each={slots}>
            {(slot, i) => {
              let colorInputEl!: HTMLInputElement;
              return (
                <div style={{ display: "flex", gap: "6px", "align-items": "center", "margin-bottom": "5px" }}>
                  <div
                    onClick={() => colorInputEl.click()}
                    title="Pick colour"
                    style={{
                      width: "18px", height: "18px",
                      "border-radius": "50%",
                      background: slot.color,
                      cursor: "pointer",
                      border: "2px solid rgba(255,255,255,0.25)",
                      "flex-shrink": 0,
                    }}
                  />
                  <input
                    ref={colorInputEl}
                    type="color"
                    value={slot.color}
                    style={{ display: "none" }}
                    onInput={(e) => setSlots(i(), "color", e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    placeholder={`Keyword ${i() + 1}`}
                    value={slot.keyword}
                    onInput={(e) => setSlots(i(), "keyword", e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") applyHighlights(); }}
                    style={{ ...searchInputStyle, flex: 1, width: "auto" }}
                  />
                </div>
              );
            }}
          </For>
          <div style={{ display: "flex", gap: "6px", "justify-content": "flex-end", "margin-top": "8px" }}>
            <button onClick={clearHighlights} style={navBtn}>Clear</button>
            <button
              onClick={applyHighlights}
              style={{ ...navBtn, background: C.accentBg, color: C.accent, border: `1px solid ${C.accentBdr}` }}
            >
              Apply
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

const searchBarStyle = {
  position: "absolute",
  top: "10px",
  right: "14px",
  display: "flex",
  "align-items": "center",
  gap: "4px",
  background: "rgba(28,28,30,0.92)",
  "backdrop-filter": "blur(16px) saturate(160%)",
  border: `1px solid ${C.border}`,
  "border-radius": "10px",
  padding: "5px 8px",
  "box-shadow": "0 8px 24px rgba(0,0,0,0.5)",
  "z-index": "10",
} as const;

const highlightPanelStyle = {
  position: "absolute",
  top: "58px",
  right: "14px",
  background: "rgba(28,28,30,0.95)",
  "backdrop-filter": "blur(16px) saturate(160%)",
  border: `1px solid ${C.border}`,
  "border-radius": "10px",
  padding: "10px 12px",
  "box-shadow": "0 8px 24px rgba(0,0,0,0.5)",
  "z-index": "10",
  width: "260px",
} as const;

const searchInputStyle = {
  background: C.bg3,
  color: C.text,
  border: `1px solid ${C.border}`,
  padding: "4px 8px",
  "border-radius": "6px",
  "font-size": "13px",
  outline: "none",
  width: "200px",
} as const;

const toggleBtn = (active: boolean | undefined) =>
  ({
    background: active ? C.accentBg : "transparent",
    color: active ? C.accent : C.text2,
    border: `1px solid ${active ? C.accentBdr : C.border}`,
    "border-radius": "5px",
    padding: "2px 6px",
    "font-size": "11px",
    cursor: "pointer",
    "font-family": "monospace",
    "min-width": "26px",
  }) as const;

const navBtn = {
  background: "transparent",
  color: C.text2,
  border: `1px solid ${C.border}`,
  "border-radius": "5px",
  padding: "2px 8px",
  "font-size": "12px",
  cursor: "pointer",
} as const;

const reconnectOverlay = {
  position: "absolute",
  inset: "0",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.6)",
  "backdrop-filter": "blur(8px)",
  "z-index": "5",
} as const;

const reconnectCard = {
  background: "rgba(30,30,32,0.97)",
  "backdrop-filter": "blur(40px) saturate(180%)",
  border: `1px solid ${C.border}`,
  "border-radius": "14px",
  "box-shadow": "0 24px 64px rgba(0,0,0,0.75)",
  padding: "24px 28px",
  "min-width": "320px",
  "max-width": "480px",
  color: C.text,
} as const;

const pwInput = {
  flex: 1,
  background: C.bg3,
  color: C.text,
  border: `1px solid ${C.border}`,
  padding: "7px 10px",
  "border-radius": "8px",
  "font-size": "13px",
  outline: "none",
} as const;

const dropOverlayStyle = {
  position: "absolute",
  inset: "0",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.55)",
  "backdrop-filter": "blur(4px)",
  "z-index": "11",
  "pointer-events": "none",
} as const;

const dropCardStyle = {
  padding: "20px 36px",
  border: "2px dashed",
  "border-radius": "12px",
  background: "rgba(30,30,32,0.85)",
  "font-size": "14px",
  "font-weight": 500,
} as const;

/** Wrap a filesystem path so a shell will treat it as one argument. Plain
 *  double-quotes are safe for typical paths on Windows (PowerShell) and
 *  POSIX (bash/zsh) — backslashes inside `"..."` are literal in both. Paths
 *  containing a literal `"` aren't perfectly portable; rare enough to skip. */
function quoteShellPath(p: string): string {
  if (/[\s"'`$|&;<>(){}[\]\\]/.test(p)) {
    return `"${p.replace(/"/g, '\\"')}"`;
  }
  return p;
}

const primaryBtn = {
  background: C.accent,
  color: "#fff",
  border: "none",
  padding: "7px 18px",
  "border-radius": "8px",
  "font-size": "13px",
  cursor: "pointer",
  "font-weight": 600,
} as const;
