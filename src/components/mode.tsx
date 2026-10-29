"use client";

/**
 * Light/dark mode for the Snowflake token system.
 *
 * WHERE THE MODE LIVES
 * --------------------
 * On `<html data-mode>`, which tokens.css reads. A tiny inline script in
 * layout.tsx sets it before first paint from localStorage `sf-mode`, so a
 * reload in dark never flashes light. This provider only mirrors that value
 * into React and writes changes back; it never decides the starting mode
 * itself, which is why it reads the attribute on mount instead of a default.
 *
 * Components never test the mode. Colours come from tokens, so the same class
 * is right in both modes; the only consumers of `useMode` are things that
 * paint outside CSS (canvas charts) and the toggle.
 *
 * `sf-mode-change` is dispatched for any chart that caches colours. Recharts
 * here styles SVG with `var(--…)`, so it repaints without listening.
 */

import * as React from "react";

export type Mode = "light" | "dark";

const ModeContext = React.createContext<{
  mode: Mode;
  setMode: (mode: Mode) => void;
  canToggle: boolean;
}>({ mode: "light", setMode: () => {}, canToggle: true });

export function ModeProvider({
  modes,
  defaultMode,
  children,
}: {
  modes: readonly string[];
  defaultMode: Mode;
  children: React.ReactNode;
}) {
  const [mode, setModeState] = React.useState<Mode>(defaultMode);

  React.useEffect(() => {
    const current = document.documentElement.dataset.mode;
    if (current === "light" || current === "dark") setModeState(current);
  }, []);

  const setMode = React.useCallback((next: Mode) => {
    document.documentElement.dataset.mode = next;
    // Storage can be blocked (private windows, policy); the app must still work.
    try { localStorage.setItem("sf-mode", next); } catch { /* not persisted */ }
    setModeState(next);
    window.dispatchEvent(new CustomEvent("sf-mode-change", { detail: next }));
  }, []);

  const value = React.useMemo(
    () => ({ mode, setMode, canToggle: modes.length > 1 }),
    [mode, setMode, modes.length],
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export const useMode = () => React.useContext(ModeContext);

/** Sun/moon segmented control for the top bar. Hidden for single-mode hosts. */
export function ModeToggle() {
  const { mode, setMode, canToggle } = useMode();
  if (!canToggle) return null;
  return (
    <div className="mode-toggle" role="group" aria-label="Colour mode">
      <button
        type="button"
        aria-pressed={mode === "light"}
        aria-label="Light mode"
        onClick={() => setMode("light")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={mode === "dark"}
        aria-label="Dark mode"
        onClick={() => setMode("dark")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
        </svg>
      </button>
    </div>
  );
}
