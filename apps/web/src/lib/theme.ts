import { useSyncExternalStore } from "react";

/**
 * Light/dark theming. The user picks one of three choices; "system" tracks the OS and
 * live-updates when it flips. The resolved theme is applied as a `data-theme="dark"`
 * attribute on `<html>` (absence = light), which flips the CSS variables in styles.css.
 *
 * The choice is persisted as a RAW string under `lexiprep.theme` (not JSON) so the tiny
 * pre-paint script in index.html can read it without a parser. Keep the two in sync.
 */
export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "lexiprep.theme";
const CHOICES: ThemeChoice[] = ["system", "light", "dark"];

export function getStoredTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && (CHOICES as string[]).includes(raw) ? (raw as ThemeChoice) : "system";
  } catch {
    // Storage blocked (private mode) — fall back to following the OS.
    return "system";
  }
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  return prefersDark() ? "dark" : "light";
}

function applyResolved(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (resolved === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

// ── Reactive store (no provider): a snapshot the useTheme() hook subscribes to. ──────
let choice: ThemeChoice = getStoredTheme();
let resolved: ResolvedTheme = resolveTheme(choice);
let snapshot: { choice: ThemeChoice; resolved: ResolvedTheme } = { choice, resolved };
const listeners = new Set<() => void>();

function commit(): void {
  resolved = resolveTheme(choice);
  applyResolved(resolved);
  snapshot = { choice, resolved };
  listeners.forEach((l) => l());
}

/** Apply the stored choice and start mirroring the OS while the choice is "system". */
export function initTheme(): void {
  choice = getStoredTheme();
  commit();
  if (typeof window !== "undefined" && window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (choice === "system") commit();
      });
  }
}

/** Persist + apply a new choice and notify subscribers. */
export function setTheme(next: ThemeChoice): void {
  choice = (CHOICES as string[]).includes(next) ? next : "system";
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Best-effort persistence; the in-memory choice still applies for this session.
  }
  commit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return snapshot;
}

/** Reactive read of the current theme. Both the menu control and the toaster use this. */
export function useTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { choice: snap.choice, resolved: snap.resolved, setChoice: setTheme };
}
