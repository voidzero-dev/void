type ScrollPosition = { x: number; y: number };
type HistoryState = { __voidScrollKey?: unknown; scrollX?: unknown; scrollY?: unknown } | null;
type ScrollRestoration = {
  readonly ready: boolean;
  start(): ScrollPosition | null;
  save(): void;
  writeHistory(url: string, replace: boolean): void;
  commit(): void;
  pop(state: HistoryState): ScrollPosition | null;
};

const STORAGE_PREFIX = 'void:scroll:';

function readKey(state: HistoryState): string | null {
  return typeof state?.__voidScrollKey === 'string' ? state.__voidScrollKey : null;
}

function readPosition(value: unknown): ScrollPosition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : null;
}

function newKey(): string {
  return crypto.getRandomValues(new Uint32Array(4)).join('-');
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

/** Positions belong to the rendered entry, even after the browser starts a traversal. */
export function createScrollRestoration(): ScrollRestoration {
  const positions = new Map<string, ScrollPosition>();
  let renderedKey: string | null = null;
  let renderedUrl = currentUrl();
  let ready = false;

  function read(key: string | null): ScrollPosition | null {
    if (!key) {
      return null;
    }
    const position = positions.get(key);
    if (position) {
      return position;
    }
    try {
      const saved = readPosition(
        JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + key) || 'null'),
      );
      if (saved) {
        return saved;
      }
    } catch {
      // Same-document restoration still works when session storage is unavailable.
    }
    return null;
  }

  function save(): void {
    if (!ready || !renderedKey) {
      return;
    }
    const position = { x: window.scrollX, y: window.scrollY };
    positions.set(renderedKey, position);
    try {
      sessionStorage.setItem(STORAGE_PREFIX + renderedKey, JSON.stringify(position));
    } catch {
      // Keep the in-memory position for the lifetime of this document.
    }
  }

  return {
    get ready() {
      return ready;
    },

    start(): ScrollPosition | null {
      renderedKey = readKey(history.state);
      if (!renderedKey) {
        renderedKey = newKey();
        history.replaceState({ ...history.state, __voidScrollKey: renderedKey }, '');
      }
      history.scrollRestoration = 'manual';
      // Do not mutate history here: WebKit can already expose the incoming entry.
      window.addEventListener('pagehide', save);
      return read(renderedKey);
    },

    save,

    writeHistory(url: string, replace: boolean): void {
      // A replaced entry keeps its key: its position is saved again when it is left.
      const key = (replace ? readKey(history.state) : null) ?? newKey();
      const state = { ...(replace ? history.state : {}), __voidScrollKey: key };
      if (replace) {
        history.replaceState(state, '', url);
      } else {
        history.pushState(state, '', url);
      }
      // Only once the entry exists: if the write throws, positions keep the current entry's key.
      renderedKey = key;
    },

    commit(): void {
      renderedKey = readKey(history.state) ?? renderedKey;
      renderedUrl = currentUrl();
      ready = true;
    },

    pop(state: HistoryState): ScrollPosition | null {
      save();
      let key = readKey(state);
      // Ordinary fragment links copy the previous entry's state. Give the new
      // fragment entry its own identity before the adapter commits it.
      const newFragment = key === renderedKey && currentUrl() !== renderedUrl;
      if (!key || newFragment) {
        key = newKey();
        history.replaceState({ ...state, __voidScrollKey: key }, '');
      }
      return newFragment
        ? null
        : (read(key) ?? readPosition({ x: state?.scrollX, y: state?.scrollY }));
    },
  };
}
