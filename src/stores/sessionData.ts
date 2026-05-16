import type { UnlistenFn } from "@tauri-apps/api/event";
import { Channel } from "@tauri-apps/api/core";
import { api } from "../ipc/api";

export type SessionDataCallback = (bytes: Uint8Array) => void;

interface SessionDataEntry {
  callbacks: Set<SessionDataCallback>;
  unlisten: UnlistenFn | null;
  opening: Promise<void> | null;
  pipe: PendingDataPipeImpl | null;
}

const sessions = new Map<string, SessionDataEntry>();
const PRE_BIND_BACKLOG_BYTES = 256 * 1024;

function getEntry(sessionId: string): SessionDataEntry {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = {
      callbacks: new Set(),
      unlisten: null,
      opening: null,
      pipe: null,
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
  if (entry.pipe) {
    entry.pipe.replayBacklog(cb);
  } else {
    openEventBackedSessionData(sessionId);
  }

  return () => {
    const active = sessions.get(sessionId);
    if (!active) return;
    active.callbacks.delete(cb);
    if (active.callbacks.size === 0 && !active.pipe) {
      active.unlisten?.();
      sessions.delete(sessionId);
    }
  };
}

export interface PendingDataPipe {
  channel: Channel<ArrayBuffer>;
  bindSession(sessionId: string): void;
  subscribe(cb: SessionDataCallback): () => void;
  dispose(): void;
}

type ChannelMessage = ArrayBuffer | ArrayBufferView | number[];

function toBytes(message: ChannelMessage): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return new Uint8Array(message);
}

class PendingDataPipeImpl implements PendingDataPipe {
  readonly channel: Channel<ArrayBuffer>;
  private sessionId: string | null = null;
  private callbacks = new Set<SessionDataCallback>();
  private backlog: Uint8Array[] = [];
  private backlogBytes = 0;
  private disposed = false;

  constructor() {
    this.channel = new Channel<ArrayBuffer>((message) => {
      this.dispatch(toBytes(message as ChannelMessage));
    });
  }

  bindSession(sessionId: string) {
    if (this.disposed) return;
    if (this.sessionId && this.sessionId !== sessionId) {
      this.dispose();
    }
    this.sessionId = sessionId;
    const entry = getEntry(sessionId);
    entry.pipe = this;
    this.callbacks.forEach((cb) => entry.callbacks.add(cb));
    if (entry.callbacks.size > 0) {
      this.replayBacklogToCallbacks(entry.callbacks);
      this.clearBacklog();
    }
  }

  subscribe(cb: SessionDataCallback): () => void {
    if (this.disposed) return () => {};
    this.callbacks.add(cb);
    if (this.sessionId) {
      const entry = getEntry(this.sessionId);
      entry.callbacks.add(cb);
      this.replayBacklog(cb);
      this.clearBacklog();
    } else {
      this.replayBacklog(cb);
    }
    return () => {
      this.callbacks.delete(cb);
      if (!this.sessionId) return;
      const entry = sessions.get(this.sessionId);
      entry?.callbacks.delete(cb);
    };
  }

  replayBacklog(cb: SessionDataCallback) {
    this.backlog.forEach((bytes) => cb(bytes));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.callbacks.clear();
    this.backlog = [];
    this.backlogBytes = 0;
    if (this.sessionId) {
      const entry = sessions.get(this.sessionId);
      if (entry?.pipe === this) {
        entry.callbacks.clear();
        sessions.delete(this.sessionId);
      }
    }
    this.sessionId = null;
  }

  private dispatch(bytes: Uint8Array) {
    if (this.disposed) return;
    if (this.sessionId) {
      const entry = sessions.get(this.sessionId);
      if (entry) {
        if (entry.callbacks.size === 0) {
          this.addBacklog(bytes);
          return;
        }
        entry.callbacks.forEach((cb) => cb(bytes));
        return;
      }
    }
    if (this.callbacks.size === 0) {
      this.addBacklog(bytes);
      return;
    }
    this.callbacks.forEach((cb) => cb(bytes));
  }

  private addBacklog(bytes: Uint8Array) {
    if (bytes.byteLength === 0) return;
    const copy = new Uint8Array(bytes);
    this.backlog.push(copy);
    this.backlogBytes += copy.byteLength;
    while (this.backlogBytes > PRE_BIND_BACKLOG_BYTES && this.backlog.length > 0) {
      const removed = this.backlog.shift();
      this.backlogBytes -= removed?.byteLength ?? 0;
    }
  }

  private replayBacklogToCallbacks(callbacks: Set<SessionDataCallback>) {
    this.backlog.forEach((bytes) => callbacks.forEach((cb) => cb(bytes)));
  }

  private clearBacklog() {
    this.backlog = [];
    this.backlogBytes = 0;
  }
}

export function createPendingDataPipe(): PendingDataPipe {
  return new PendingDataPipeImpl();
}
