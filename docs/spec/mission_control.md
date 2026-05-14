# Mission Control / Exposé / Task View

## Goal

Trigger a hotkey or click a toolbar button to show **all open terminal tabs as
live thumbnails in a padded grid overlay** — modeled after macOS Mission
Control / Exposé and Windows Task View. Clicking a thumbnail zooms it back to
full size and dismisses the overlay; pressing `Esc` cancels.

## Trigger

- Hotkey: `Ctrl+Shift+E` (Exposé). Optional secondary: `F3` (matches Windows Task View).
- Toolbar button in the header next to `📟 Terminal` / `🌿 Git`, label like `▦ Expose`.
- Skip the hotkey when `isActiveTabPassthrough()` is true (existing pattern in `App.tsx`).
- Don't open when `tabs().length < 2` (nothing to switch between).

## Spike result (step 1) — recorded 2026-05-13

The first plan was option 2: snapshot xterm's canvases via `toDataURL` on
overlay open. The spike (`__exposeSpike` hook in `Terminal.tsx`) tested whether
hidden tabs' canvases are rasterizable.

**Result: hidden xterm canvases are blank.** Three tests, all failed:

1. Direct `toDataURL` on a hidden tab → PNG bytes are non-trivial size (47 KB)
   but pure black when viewed.
2. Flip `visibility: visible` off-screen + double `requestAnimationFrame` +
   snapshot → still pure black.
3. Flip visible + wait 100ms + snapshot → still pure black.

Conclusion: the `xterm-webgl` addon skips draw calls when its element isn't
being rendered by the browser compositor. Toggling visibility doesn't trigger
a fresh paint. **Snapshot-based approaches are not viable** without keeping
each terminal continuously visible.

## Chosen approach: live DOM repositioning (was option 1)

Each `TerminalView` is moved into a grid cell when the overlay is open, using
CSS `transform: scale()` to shrink it. Thumbnails are truly live — output
keeps flowing while the user picks one.

### Why this works

- Terminals stay in the DOM and remain "rendered" from the compositor's
  perspective, so xterm-webgl keeps painting them.
- `transform: scale()` is a GPU-composited transform that doesn't trigger
  layout recalculation, so FitAddon's reported size stays at the full pre-
  scale dimensions — the terminal keeps its real cols/rows and the remote
  shell isn't told to reflow. The thumbnail just *looks* small.
- Click-to-zoom can use a FLIP-style transform animation from the cell's
  position back to full-pane size.

### Risks / things to verify during implementation

- **CSS transform-origin**: must be set per-cell so each terminal scales from
  its grid cell's top-left, not its absolute-positioned origin.
- **Click-through during animation**: while a thumbnail is animating to
  full-size, pointer events on the underlying terminal must be disabled until
  the animation finishes.
- **Resize during overlay**: if the window is resized while Exposé is open,
  the grid reflows; the terminals' actual sizes don't change, only the scale
  factor does.
- **WebGL context limits**: many large hidden contexts may already exist; the
  grid layout just makes them visible. No new contexts created.

## UX decisions

- **Overlay scope**: full-window takeover. Tab bar, Git panel, side terminal,
  header toolbar are all hidden behind a blurred dimming layer while Exposé
  is open. Matches macOS Mission Control's immersive feel.
- **Zoom animation**: clicked thumbnail's terminal animates (FLIP transform)
  from its grid position back to full pane size over ~200ms before the
  overlay dismisses.

## Implementation

### 1. Store — `src/stores/expose.ts`

- `isExposeOpen()` signal.
- `openExpose()`, `closeExpose()`, `toggleExpose()`.
- `zoomingTabId()` signal: while non-null, that tab is animating from grid
  cell to full size. The overlay stays visible (but other cells fade) until
  animation completes.

### 2. Refactor `App.tsx`'s terminal pane layout

Today the terminal pane uses absolute positioning so all tabs stack and only
the active one is visible (`App.tsx:385-399`). For Exposé we need the same
DOM to be reused in a grid mode.

Approach:
- Wrap the `<For each={tabs()}>` block with a container that switches between
  two layout modes: **stacked** (current — absolute, only active visible) and
  **grid** (CSS grid, all visible, each terminal scaled down).
- `TerminalView`'s outer wrapper currently uses `position: absolute; inset: 0;
  visibility: hidden/visible`. In grid mode, it must instead participate in
  flow with `position: relative; transform: scale(...)`. Pass a `mode` prop
  (`"stacked"` | `"grid"`) and switch styles.
- Grid container: `display: grid; gap: 24px; padding: 48px;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))`.

### 3. Overlay chrome — `src/components/ExposeView.tsx`

Even though terminals are rendered by `TerminalView`, the *overlay* component
provides the surrounding chrome:
- Full-window backdrop: `position: fixed; inset: 0;
  background: rgba(11,11,15,0.85); backdrop-filter: blur(20px); z-index: 100`.
  Renders **behind** the grid container (which is lifted to a higher
  z-index while overlay is open).
- Per-cell decoration overlays positioned over each terminal's grid cell:
  status pill, tab name/icon, hover border. These read from `tabs()` and use
  the grid container's layout (could be siblings inside the same grid).
- Esc key handler + background-click handler → `closeExpose()`.
- Active tab gets a persistent accent border so the user sees "where I was."

### 4. Click → zoom animation

On thumbnail click:
1. Read the cell's current bounding rect.
2. Set `zoomingTabId(id)`, `setActiveTab(id)`.
3. Apply a CSS transition: scale + translate from cell rect to full-pane
   rect over ~200ms (FLIP technique: invert delta, then play forward).
4. Fade other cells + backdrop to 0 simultaneously.
5. On `transitionend`: `closeExpose()`, clear `zoomingTabId`, terminal
   resumes its normal stacked-mode position.

Click-through is disabled on all other cells during the animation.

### 5. Wiring — `App.tsx`

- `keydown` handler around `App.tsx:166`: add `Ctrl+Shift+E` → `toggleExpose()`.
  Guard with `isActiveTabPassthrough()`.
- Toolbar button in the right-side toolbar (`App.tsx:305`), label `▦ Expose`.
- Render `<Show when={isExposeOpen()}><ExposeView /></Show>` at the root.
- The terminal pane reads `isExposeOpen()` to choose stacked-vs-grid mode.

## Edge cases

- **Single tab or zero tabs**: don't open.
- **Disconnected tabs**: still show in the grid (xterm's last frame stays
  visible). Status pill reflects state. Click still activates that tab.
- **Tab closed while overlay open**: SolidJS drops the cell naturally.
- **New tab created while overlay open**: appears in the grid (the `<For>`
  reflows).
- **Reconnect panel overlay** on the terminal (the existing
  `showReconnectPanel` UI inside `TerminalView`): will appear scaled-down
  inside the thumbnail. Acceptable — gives the user a visible signal that
  the tab needs attention.

## Out of scope (v2 ideas)

- Keyboard navigation inside the overlay (arrow keys + Enter to select).
- Right-click context menu on a thumbnail (close, rename, etc.).
- Drag-to-reorder from the grid.
- Workspace / grouping view.
- Thumbnail size slider.

## Suggested implementation order

1. ~~Spike: verify hidden xterm canvases are snapshot-able.~~ **Done — failed.
   Pivoted to live DOM repositioning.**
2. Remove the `__exposeSpike` debug hook from `Terminal.tsx`.
3. Add the `expose` store + an `Expose` toolbar button that toggles it.
4. Refactor `App.tsx` + `TerminalView`'s outer wrapper to support a
   `grid` mode alongside the current `stacked` mode. Initially: no
   animation, no overlay chrome — just confirm terminals render correctly
   when scaled in a grid.
5. Add the overlay chrome (backdrop, per-cell labels, Esc / background-click
   dismissal, accent border on active tab).
6. Add the hotkey binding.
7. Add the click-to-zoom FLIP animation.
8. Polish: hover state, fade-in stagger, focus management.
