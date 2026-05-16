import type { UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../ipc/api";

export type SessionDataCallback = (bytes: Uint8Array) => void;

interface SessionDataEntry {
  callbacks: Set<SessionDataCallback>;
  unlisten: UnlistenFn | null;
  opening: Promise<void> | null;
}

const sessions = new Map<string, SessionDataEntry>();

function getEntry(sessionId: string): SessionDataEntry {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = {
      callbacks: new Set(),
      unlisten: null,
      opening: null,
    };
    sessions.set(sessionId, entry);
  }
  return entry;
}

export function openEventBackedSessionData(sessionId: string): () => void {
  const entry = getEntry(sessionId);
  if (!entry.unlisten && !entry.opening) {
    entry.opening = api
      .onSshData(sessionId, (bytes) => {
        const active = sessions.get(sessionId);
        if (!active) return;
        active.callbacks.forEach((cb) => cb(bytes));
      })
      .then((unlisten) => {
        const active = sessions.get(sessionId);
        if (!active) {
          unlisten();
          return;
        }
        active.unlisten = unlisten;
      })
      .catch((e) => {
        sessions.delete(sessionId);
        console.warn("session data listener", e);
      })
      .finally(() => {
        const active = sessions.get(sessionId);
        if (active) active.opening = null;
      });
  }

  return () => {
    const active = sessions.get(sessionId);
    if (!active) return;
    active.callbacks.clear();
    active.unlisten?.();
    sessions.delete(sessionId);
  };
}

export function subscribeSessionData(
  sessionId: string,
  cb: SessionDataCallback,
): () => void {
  const entry = getEntry(sessionId);
  entry.callbacks.add(cb);
  openEventBackedSessionData(sessionId);

  return () => {
    const active = sessions.get(sessionId);
    if (!active) return;
    active.callbacks.delete(cb);
    if (active.callbacks.size === 0) {
      active.unlisten?.();
      sessions.delete(sessionId);
    }
  };
}
