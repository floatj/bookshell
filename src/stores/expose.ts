import { createSignal } from "solid-js";

const [isExposeOpen, setExposeOpen] = createSignal(false);
const [zoomingTabId, setZoomingTabId] = createSignal<string | null>(null);

export { isExposeOpen, zoomingTabId };

export function openExpose() {
  setExposeOpen(true);
}

export function closeExpose() {
  setExposeOpen(false);
  setZoomingTabId(null);
}

export function toggleExpose() {
  if (isExposeOpen()) closeExpose();
  else openExpose();
}

export function startZoom(tabId: string) {
  setZoomingTabId(tabId);
}
