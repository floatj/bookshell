import { createSignal } from "solid-js";
import { api, type GeneralSettings } from "../ipc/api";

const defaults: GeneralSettings = {
  scrollback: 10000,
  font_size: 14,
  side_font_size: 14,
  git_poll_secs: 5,
  default_shell: null,
  font_family: null,
  side_tab_bar_mode: "split",
  side_tab_bar_auto_hide: false,
  side_tab_bar_width: 190,
  side_tab_bar_preview: true,
  acrylic_enabled: false,
  acrylic_opacity: 0.75,
  command_bar_auto_hide: false,
  session_logging_enabled: true,
  cursor_blink: true,
};

const DEFAULT_TERM_FONT_STACK = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

/** Resolve the xterm fontFamily string by prepending the user's preferred
 *  font (when set) to the built-in monospace fallback stack. The preferred
 *  font is quoted only when it contains whitespace, mirroring CSS rules. */
export function terminalFontFamily(): string {
  const pref = (general().font_family ?? "").trim();
  if (!pref) return DEFAULT_TERM_FONT_STACK;
  const quoted = /\s/.test(pref) && !/^["'].*["']$/.test(pref) ? `"${pref}"` : pref;
  return `${quoted}, ${DEFAULT_TERM_FONT_STACK}`;
}

const [general, setGeneral] = createSignal<GeneralSettings>(defaults);
export { general };

export async function loadGeneral() {
  try {
    setGeneral(await api.generalGet());
  } catch (e) {
    console.error("loadGeneral", e);
    setGeneral(defaults);
  }
}

export async function updateGeneral(patch: Partial<GeneralSettings>) {
  const next = { ...general(), ...patch };
  setGeneral(next);
  try {
    await api.generalSet(next);
  } catch (e) {
    console.error("updateGeneral", e);
  }
}
