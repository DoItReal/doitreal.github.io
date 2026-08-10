/**
 * Analytics: the event schema, defined before gameplay code (developer.md).
 *
 * No vendor yet. Events buffer in localStorage and print to the console so a
 * playtest produces real numbers today; `flush()` is the single seam where a
 * provider gets wired in later without touching game code.
 *
 * Every event carries the anonymous install id, session id, build, and the loop
 * iteration count - without the loop counter we cannot see where the loop breaks.
 */

const BUILD = "0.1.0-hotelcareer";
const KEY_INSTALL = "hc_install_id";
const KEY_EVENTS = "hc_events";

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function storage() {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* private mode / file:// restrictions - fall through to memory */
  }
  const memory = new Map();
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, v),
  };
}

const store = storage();

function installId() {
  let id = store.getItem(KEY_INSTALL);
  if (!id) {
    id = uuid();
    store.setItem(KEY_INSTALL, id);
  }
  return id;
}

export class Analytics {
  constructor() {
    this.sessionId = uuid();
    this.installId = installId();
    this.loopIteration = 0;
    this.startedAt = Date.now();
    this.events = [];
  }

  track(name, props = {}) {
    const event = {
      event: name,
      ts: Date.now(),
      install_id: this.installId,
      session_id: this.sessionId,
      build: BUILD,
      loop_iteration: this.loopIteration,
      ...props,
    };
    this.events.push(event);
    try {
      const all = JSON.parse(store.getItem(KEY_EVENTS) || "[]");
      all.push(event);
      store.setItem(KEY_EVENTS, JSON.stringify(all.slice(-500)));
    } catch {
      /* quota or serialisation failure must never break gameplay */
    }
    if (typeof console !== "undefined") console.debug("[analytics]", name, props);
    return event;
  }

  levelStart(level) {
    this.loopIteration += 1;
    this.track("level_start", { level });
  }

  levelComplete(level, moves, parMoves, seconds) {
    this.track("level_complete", { level, moves, par_moves: parMoves, seconds });
  }

  sessionEnd() {
    this.track("session_end", { seconds: Math.round((Date.now() - this.startedAt) / 1000) });
  }

  /** Exposed so a playtester can hand us their raw event log. */
  export() {
    try {
      return store.getItem(KEY_EVENTS) || "[]";
    } catch {
      return JSON.stringify(this.events);
    }
  }
}

