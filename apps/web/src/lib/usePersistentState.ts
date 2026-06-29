import { useRef, useState } from "react";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Malformed JSON, or storage blocked (private mode) — fall back to the default.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage unavailable — persistence is best-effort, never fatal.
  }
}

/**
 * `useState` that persists to `localStorage` under `key`. The initial value comes from
 * storage (falling back to `initial`), and every update is written back.
 *
 * When `key` changes between renders (e.g. navigating from one book's page to another —
 * each keyed by its id, on a route that reuses the component instance) the value is
 * re-read from storage for the new key, so each key keeps its own remembered state.
 * Passing `key: null` disables persistence (in-memory only) — used while a route param
 * is still resolving so we don't read/write under an empty key.
 */
export function usePersistentState<T>(
  key: string | null,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (key ? read(key, initial) : initial));
  const keyRef = useRef(key);

  // Key changed under us (same instance, different storage bucket): adopt the new key's
  // stored value during render — the standard React "derive state from a changing prop"
  // pattern, guarded so it runs once per key change and re-renders before commit (no flash).
  if (key !== keyRef.current) {
    keyRef.current = key;
    setValue(key ? read(key, initial) : initial);
  }

  const set = (next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (keyRef.current) write(keyRef.current, v);
      return v;
    });
  };

  return [value, set];
}
