"use client";

import * as React from "react";
import { UserRound } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface PersonaOption {
  userId: string;
  displayName: string;
  roleLabel: string;
  title: string | null;
}

/**
 * "Acting as" picker for the simulated personas behind the approvals workflow.
 *
 * The persona is held in an httpOnly cookie and resolved on the server for
 * every request, so switching reloads the page: each screen re-reads what the
 * new persona is allowed to do rather than trusting client state.
 *
 * `variant="top"` is the top-bar layout (avatar initials, name and role, the
 * same picker); the default is the stacked layout used in the mobile header.
 * Both share every line of state and behaviour.
 */
export function PersonaSwitcher({ variant = "stacked" }: { variant?: "stacked" | "top" } = {}) {
  const [personas, setPersonas] = React.useState<PersonaOption[]>([]);
  const [current, setCurrent] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/personas")
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          return;
        }
        setPersonas(json.personas ?? []);
        setCurrent(json.current?.userId ?? null);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (userId: string | null) => {
    if (!userId || userId === current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/personas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not switch persona");
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const selected = personas.find((persona) => persona.userId === current);

  if (variant === "top") {
    const initials = (selected?.displayName ?? "")
      .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
    return (
      <div className="persona" title={selected?.title ?? undefined}>
        <div className="avatar" aria-hidden="true">{initials || <UserRound size={14} />}</div>
        <div className="min-w-0">
          <Select value={current} onValueChange={(value) => void change(value as string | null)} disabled={busy || personas.length === 0}>
            <SelectTrigger
              className="h-auto min-w-[180px] border-0 bg-transparent p-0 text-left shadow-none dark:bg-transparent"
              aria-label="Acting as persona"
            >
              <span className="block min-w-0">
                <b className="truncate">{selected ? selected.displayName : error ? "Personas unavailable" : "Loading…"}</b>
                <span className="block truncate">
                  {selected ? `${selected.roleLabel} · simulated` : "Switch persona"}
                </span>
              </span>
            </SelectTrigger>
            <SelectContent>
              {personas.map((persona) => (
                <SelectItem key={persona.userId} value={persona.userId}>
                  {persona.displayName} · {persona.roleLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <span className="text-negative">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="px-2.5 pb-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-text-tertiary">
        <span className="flex items-center gap-1">
          <UserRound size={12} aria-hidden="true" />
          Acting as
        </span>
        <span className="rounded-sm border border-border px-1 text-[10px] uppercase">
          Simulated
        </span>
      </div>
      {/* null, not undefined, while loading: the Select must stay controlled from the first render. */}
      <Select value={current} onValueChange={(value) => void change(value as string | null)} disabled={busy || personas.length === 0}>
        <SelectTrigger className="w-full text-xs" aria-label="Acting as persona">
          <SelectValue placeholder={error ? "Personas unavailable" : "Loading…"} />
        </SelectTrigger>
        <SelectContent>
          {personas.map((persona) => (
            <SelectItem key={persona.userId} value={persona.userId}>
              {persona.displayName} · {persona.roleLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected?.title && <p className="mt-1 truncate text-[11px] text-text-tertiary">{selected.title}</p>}
      {error && <p className="mt-1 text-[11px] text-negative">{error}</p>}
    </div>
  );
}
