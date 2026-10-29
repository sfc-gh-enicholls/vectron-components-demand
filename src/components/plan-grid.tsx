"use client";

/**
 * Weekly planning grid.
 *
 * Interaction model ported from SDP Configurator 5.0's TimePlanningGrid
 * (cell editing, keyboard navigation, copy/paste, ten-step undo, fill handle,
 * range totals, a frozen label column), rebuilt on this app's tokens and
 * changed in four ways:
 *
 * 1. Edits are BUFFERED. Typing, pasting and filling only mark cells as
 *    pending; nothing is written until the page's submit action runs, and the
 *    page decides what an edit means (a scenario edit spread to children on
 *    /hierarchy, a stream input for approval on /plan). The grid never writes.
 * 2. Typed input goes through parseGridInput (the formula parser), not
 *    `Function(...)`, and is not rounded to an integer.
 * 3. Shortcuts listen on the focused grid only, not on the window whenever the
 *    pointer is over it.
 * 4. Side effects never run inside React state updaters, which StrictMode
 *    invokes twice.
 *
 * Roll-up and horizon columns, formula rows, locked cells and anything the page
 * marks read-only cannot be edited.
 */
import * as React from "react";
import { ChevronDown, ChevronRight, Lock, Undo2, Send, X, Sigma } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { editKey, findOverlaps, parseGridInput, type GridEdit } from "@/lib/grid-edits";

export interface GridMeasure {
  code: string;
  label: string;
  unit: string;
  group: string;
  editable: boolean;
  description: string | null;
  expression: string | null;
  aggExpression: string | null;
}

export interface GridColumnDef {
  key: string;
  label: string;
  kind: "week" | "month" | "quarter" | "total";
  weeks: string[];
}

export interface GridRowDef {
  key: string;
  label: string;
  isTotal: boolean;
  cells: Record<string, Record<string, number | null>>;
  locked: Record<string, number>;
  leafCount: number;
  /** Why this row cannot be edited (a cross-section, or the root), or null. */
  writeBlock?: string | null;
}

export interface PlanGridProps {
  measures: GridMeasure[];
  columns: GridColumnDef[];
  rows: GridRowDef[];
  /** The measure shown on each row's main line. */
  primaryMeasure?: string;
  /** Measures this page lets the planner type into. */
  editableMeasures: string[];
  /** When set, nothing is editable and this explains why. */
  readOnlyReason?: string | null;
  /** Hand the pending batch to the page. Return an error message, or null on success. */
  onSubmit: (edits: GridEdit[]) => Promise<string | null>;
  submitLabel: string;
  /** Shown beside the submit button, e.g. "Spread to children by statistical share". */
  submitHint?: React.ReactNode;
  busy?: boolean;
  caption?: string;
  /** Change this after a successful submit: the reload keeps the same rows and columns, so pending edits must be cleared explicitly. */
  resetToken?: number;
  /** Called whenever the pending buffer changes, so a page can drop a preview made from an older buffer. */
  onPendingChange?: (count: number) => void;
}

interface Line {
  rowKey: string;
  rowLabel: string;
  isTotal: boolean;
  measure: GridMeasure;
  isSub: boolean;
}

const MAX_UNDO = 10;

function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  switch (unit) {
    case "factor":
      return value.toFixed(3);
    case "pct":
    case "share":
      return `${(value * 100).toFixed(1)}%`;
    case "EUR/pc":
      return `€${value.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
    case "kg/pc":
      return value.toFixed(3);
    case "EUR":
      if (abs >= 1e9) return `€${(value / 1e9).toFixed(2)}bn`;
      if (abs >= 1e6) return `€${(value / 1e6).toFixed(1)}m`;
      if (abs >= 1e3) return `€${(value / 1e3).toFixed(0)}k`;
      return `€${value.toFixed(0)}`;
    default:
      if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
      return value.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  }
}

function rawText(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  if (unit === "pct" || unit === "share") return `${+(value * 100).toFixed(4)}%`;
  return String(+value.toFixed(6));
}

/**
 * Parse typed or pasted text for a cell. In a percentage cell a bare number is
 * read as percent, so typing 5 means 5%, matching what the cell displays; an
 * explicit % is honoured either way.
 */
function parseCellText(text: string, unit: string): number | null {
  const value = parseGridInput(text);
  if (value === null) return null;
  const isPercentCell = unit === "pct" || unit === "share";
  return isPercentCell && !text.includes("%") ? value / 100 : value;
}

export function PlanGrid({
  measures,
  columns,
  rows,
  primaryMeasure = "PLAN_UNITS",
  editableMeasures,
  readOnlyReason = null,
  onSubmit,
  submitLabel,
  submitHint,
  busy = false,
  caption,
  resetToken = 0,
  onPendingChange,
}: PlanGridProps) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(["__node__"]));
  const [active, setActive] = React.useState<{ line: number; col: number } | null>(null);
  const [anchor, setAnchor] = React.useState<{ line: number; col: number } | null>(null);
  const [editing, setEditing] = React.useState<{ text: string } | null>(null);
  const [pending, setPending] = React.useState<Map<string, GridEdit>>(() => new Map());
  const [undo, setUndo] = React.useState<GridEdit[][]>([]);
  const [fill, setFill] = React.useState<{ line: number; from: number; to: number } | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Data changing underneath (new scope, scenario or a reload after submit)
  // invalidates pending edits made against the old numbers.
  const dataSignature = React.useMemo(
    () => `${resetToken}|${columns.map((c) => c.key).join(",")}|${rows.map((r) => r.key).join(",")}`,
    [columns, rows, resetToken],
  );
  const lastSignature = React.useRef(dataSignature);
  React.useEffect(() => {
    if (lastSignature.current !== dataSignature) {
      lastSignature.current = dataSignature;
      setPending(new Map());
      setUndo([]);
      setActive(null);
      setAnchor(null);
      setEditing(null);
    }
  }, [dataSignature]);

  const measureByCode = React.useMemo(() => new Map(measures.map((m) => [m.code, m])), [measures]);

  // A preview the page built from an earlier buffer no longer describes what
  // would be written, so every change to the buffer is reported.
  const onPendingChangeRef = React.useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;
  const firstPendingReport = React.useRef(true);
  React.useEffect(() => {
    if (firstPendingReport.current) {
      firstPendingReport.current = false;
      return;
    }
    onPendingChangeRef.current?.(pending.size);
  }, [pending]);
  const primary = measureByCode.get(primaryMeasure) ?? measures[0];
  const subMeasures = measures.filter((m) => m.code !== primary?.code);

  const lines: Line[] = React.useMemo(() => {
    const out: Line[] = [];
    if (!primary) return out;
    for (const row of rows) {
      out.push({ rowKey: row.key, rowLabel: row.label, isTotal: row.isTotal, measure: primary, isSub: false });
      if (expanded.has(row.key)) {
        for (const measure of subMeasures) {
          out.push({ rowKey: row.key, rowLabel: row.label, isTotal: row.isTotal, measure, isSub: true });
        }
      }
    }
    return out;
  }, [rows, expanded, primary, subMeasures]);

  const rowByKey = React.useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const editableSet = React.useMemo(() => new Set(editableMeasures), [editableMeasures]);

  const valueAt = React.useCallback(
    (line: Line, column: GridColumnDef): number | null => rowByKey.get(line.rowKey)?.cells[column.key]?.[line.measure.code] ?? null,
    [rowByKey],
  );

  const cellEditable = React.useCallback(
    (line: Line, column: GridColumnDef): boolean => {
      if (readOnlyReason) return false;
      if (column.kind !== "week") return false;
      if (!editableSet.has(line.measure.code) || !line.measure.editable) return false;
      const row = rowByKey.get(line.rowKey);
      if (!row || row.writeBlock) return false;
      // A node whose every leaf is locked in that week has nothing to spread into.
      if ((row.locked[column.key] ?? 0) >= 1) return false;
      return valueAt(line, column) !== null;
    },
    [readOnlyReason, editableSet, rowByKey, valueAt],
  );

  const shownValue = (line: Line, column: GridColumnDef): { value: number | null; isPending: boolean } => {
    const edit = pending.get(editKey({ rowKey: line.rowKey, measure: line.measure.code, weekId: column.key }));
    return edit ? { value: edit.value, isPending: true } : { value: valueAt(line, column), isPending: false };
  };

  const applyEdits = (edits: GridEdit[]) => {
    if (edits.length === 0) return;
    const next = new Map(pending);
    const reverse: GridEdit[] = [];
    for (const edit of edits) {
      const key = editKey(edit);
      reverse.push(next.get(key) ?? { ...edit, value: edit.previous ?? 0, previous: null });
      if (edit.previous !== null && Math.abs(edit.value - edit.previous) < 1e-9) next.delete(key);
      else next.set(key, edit);
    }
    setPending(next);
    setUndo((stack) => [...stack.slice(-(MAX_UNDO - 1)), reverse]);
    setMessage(null);
  };

  const makeEdit = (line: Line, column: GridColumnDef, value: number): GridEdit => ({
    rowKey: line.rowKey,
    isTotal: line.isTotal,
    weekId: column.key,
    measure: line.measure.code,
    value,
    previous: valueAt(line, column),
  });

  const undoLast = () => {
    const last = undo[undo.length - 1];
    if (!last) return;
    const next = new Map(pending);
    for (const entry of last) {
      const key = editKey(entry);
      // An entry with previous === null restores "no pending edit".
      if (entry.previous === null) next.delete(key);
      else next.set(key, entry);
    }
    setPending(next);
    setUndo(undo.slice(0, -1));
  };

  const selection = React.useMemo(() => {
    if (!active) return null;
    const a = anchor ?? active;
    return {
      l0: Math.min(a.line, active.line),
      l1: Math.max(a.line, active.line),
      c0: Math.min(a.col, active.col),
      c1: Math.max(a.col, active.col),
    };
  }, [active, anchor]);

  const inSelection = (lineIdx: number, colIdx: number) =>
    !!selection && lineIdx >= selection.l0 && lineIdx <= selection.l1 && colIdx >= selection.c0 && colIdx <= selection.c1;

  const rangeSummary = React.useMemo(() => {
    if (!selection || (selection.l0 === selection.l1 && selection.c0 === selection.c1)) return null;
    const values: number[] = [];
    const units = new Set<string>();
    for (let l = selection.l0; l <= selection.l1; l++) {
      for (let c = selection.c0; c <= selection.c1; c++) {
        const line = lines[l];
        const column = columns[c];
        if (!line || !column || column.kind !== "week") continue;
        const value = pending.get(editKey({ rowKey: line.rowKey, measure: line.measure.code, weekId: column.key }))?.value ?? valueAt(line, column);
        if (value !== null) {
          values.push(value);
          units.add(line.measure.unit);
        }
      }
    }
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    const unit = units.size === 1 ? [...units][0] : null;
    const additive = unit === "units" || unit === "EUR" || unit === "LPA";
    return { count: values.length, sum: additive ? sum : null, mean: sum / values.length, unit };
  }, [selection, lines, columns, pending, valueAt]);

  const startEditing = (initial?: string, at?: { line: number; col: number }) => {
    const cell = at ?? active;
    if (!cell) return;
    const line = lines[cell.line];
    const column = columns[cell.col];
    if (!line || !column || !cellEditable(line, column)) return;
    if (at) setActive(at);
    editClosed.current = false;
    setEditing({ text: initial ?? rawText(shownValue(line, column).value, line.measure.unit) });
    requestAnimationFrame(() => editorRef.current?.select());
  };

  // Enter, Tab and Escape all move focus off the input, which fires blur too.
  // This ref makes the first of those close the edit and the blur a no-op, so an
  // edit is applied once (one undo entry) and Escape really cancels.
  const editClosed = React.useRef(true);

  const cancelEditing = () => {
    editClosed.current = true;
    setEditing(null);
    gridRef.current?.focus();
  };

  const commitEditing = (move: { line: number; col: number } | null) => {
    if (!editing || !active || editClosed.current) return;
    editClosed.current = true;
    const line = lines[active.line];
    const column = columns[active.col];
    const parsed = line ? parseCellText(editing.text, line.measure.unit) : null;
    if (parsed === null) {
      setMessage({ ok: false, text: `“${editing.text}” is not a number.` });
    } else if (line && column) {
      if (line.measure.unit === "units" && parsed < 0) {
        setMessage({ ok: false, text: "A plan cannot be negative." });
      } else {
        applyEdits([makeEdit(line, column, parsed)]);
      }
    }
    setEditing(null);
    if (move) moveTo(move.line, move.col, false);
    gridRef.current?.focus();
  };

  const moveTo = (line: number, col: number, extend: boolean) => {
    const l = Math.max(0, Math.min(lines.length - 1, line));
    const c = Math.max(0, Math.min(columns.length - 1, col));
    if (!extend) setAnchor(null);
    else if (!anchor) setAnchor(active);
    setActive({ line: l, col: c });
    document.getElementById(`grid-cell-${l}-${c}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const copySelection = (event: React.ClipboardEvent) => {
    if (!selection) return;
    const text: string[] = [];
    for (let l = selection.l0; l <= selection.l1; l++) {
      const cells: string[] = [];
      for (let c = selection.c0; c <= selection.c1; c++) {
        const line = lines[l];
        const column = columns[c];
        cells.push(line && column ? rawText(shownValue(line, column).value, line.measure.unit) : "");
      }
      text.push(cells.join("\t"));
    }
    event.clipboardData.setData("text/plain", text.join("\n"));
    event.preventDefault();
  };

  const pasteIntoGrid = (event: React.ClipboardEvent) => {
    if (!active || editing) return;
    event.preventDefault();
    const grid = event.clipboardData
      .getData("text/plain")
      .replace(/\r/g, "")
      .split("\n")
      .filter((row, index, all) => row.length > 0 || index < all.length - 1)
      .map((row) => row.split("\t"));
    const edits: GridEdit[] = [];
    let skipped = 0;
    grid.forEach((cells, r) => {
      cells.forEach((text, c) => {
        const line = lines[active.line + r];
        const column = columns[active.col + c];
        if (!line || !column) return;
        const value = parseCellText(text, line.measure.unit);
        if (value === null || !cellEditable(line, column) || (line.measure.unit === "units" && value < 0)) {
          if (text.trim()) skipped += 1;
          return;
        }
        edits.push(makeEdit(line, column, value));
      });
    });
    applyEdits(edits);
    setMessage(
      skipped > 0
        ? { ok: false, text: `Pasted ${edits.length} cell(s); ${skipped} skipped (read-only or not a number).` }
        : edits.length > 0
          ? { ok: true, text: `Pasted ${edits.length} cell(s).` }
          : null,
    );
  };

  const fillTargets = (state: { line: number; from: number; to: number }) => {
    const line = lines[state.line];
    if (!line) return [];
    const [lo, hi] = state.to >= state.from ? [state.from + 1, state.to] : [state.to, state.from - 1];
    const targets: GridColumnDef[] = [];
    for (let c = lo; c <= hi; c++) {
      const column = columns[c];
      if (column && cellEditable(line, column)) targets.push(column);
    }
    return targets;
  };

  const finishFill = (state: { line: number; from: number; to: number }) => {
    const line = lines[state.line];
    const source = columns[state.from];
    if (!line || !source) return;
    const value = shownValue(line, source).value;
    if (value === null) return;
    applyEdits(fillTargets(state).map((column) => makeEdit(line, column, value)));
  };

  const fillToEnd = (lineIdx: number, colIdx: number) => {
    finishFill({ line: lineIdx, from: colIdx, to: columns.length - 1 });
  };

  const beginFillDrag = (event: React.PointerEvent, lineIdx: number, colIdx: number) => {
    event.preventDefault();
    event.stopPropagation();
    let state = { line: lineIdx, from: colIdx, to: colIdx };
    setFill(state);
    const onMove = (ev: PointerEvent) => {
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-grid-col]");
      const col = el ? Number(el.getAttribute("data-grid-col")) : NaN;
      const line = el ? Number(el.getAttribute("data-grid-line")) : NaN;
      if (Number.isFinite(col) && line === lineIdx && col !== state.to) {
        state = { ...state, to: col };
        setFill(state);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setFill(null);
      if (state.to !== state.from) finishFill(state);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onGridKeyDown = (event: React.KeyboardEvent) => {
    if (editing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      undoLast();
      return;
    }
    if (!active) {
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        moveTo(0, 0, false);
      }
      return;
    }
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (step[event.key]) {
      event.preventDefault();
      const [dl, dc] = step[event.key];
      moveTo(active.line + dl, active.col + dc, event.shiftKey);
    } else if (event.key === "Tab") {
      event.preventDefault();
      moveTo(active.line, active.col + (event.shiftKey ? -1 : 1), false);
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      startEditing();
    } else if (event.key === "Escape") {
      setAnchor(null);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      // Clear PENDING edits in the selection (back to the stored value).
      if (!selection) return;
      event.preventDefault();
      const reverts: GridEdit[] = [];
      for (let l = selection.l0; l <= selection.l1; l++) {
        for (let c = selection.c0; c <= selection.c1; c++) {
          const line = lines[l];
          const column = columns[c];
          if (!line || !column) continue;
          const existing = pending.get(editKey({ rowKey: line.rowKey, measure: line.measure.code, weekId: column.key }));
          if (existing) reverts.push({ ...existing, value: existing.previous ?? 0 });
        }
      }
      applyEdits(reverts);
    } else if (!mod && event.key.length === 1 && /[\d.\-]/.test(event.key)) {
      event.preventDefault();
      startEditing(event.key);
    }
  };

  const pendingList = [...pending.values()];
  const overlaps = findOverlaps(pendingList);

  const submit = async () => {
    if (pendingList.length === 0 || overlaps.length > 0) return;
    setSubmitting(true);
    setMessage(null);
    const failure = await onSubmit(pendingList);
    setSubmitting(false);
    if (failure) setMessage({ ok: false, text: failure });
    // On success the page reloads the matrix, which clears the buffer.
  };

  const toggle = (rowKey: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
    setActive(null);
    setAnchor(null);
  };

  if (!primary) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
          {readOnlyReason ? (
            <span className="inline-flex items-center gap-1"><Lock size={12} aria-hidden="true" /> {readOnlyReason}</span>
          ) : (
            <span>
              Type, paste (from Excel) or drag the fill handle on {editableMeasures.map((code) => measureByCode.get(code)?.label ?? code).join(" or ")} cells.
              Nothing is saved until you submit.
            </span>
          )}
          <Link href="/formulas" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
            <Sigma size={12} aria-hidden="true" /> Formulas
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {submitHint && <span className="text-xs text-text-tertiary">{submitHint}</span>}
          <Button type="button" size="sm" variant="ghost" onClick={undoLast} disabled={undo.length === 0 || submitting}>
            <Undo2 aria-hidden="true" /> Undo
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setPending(new Map());
              setUndo([]);
              setMessage(null);
            }}
            disabled={pendingList.length === 0 || submitting}
          >
            <X aria-hidden="true" /> Discard
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pendingList.length === 0 || overlaps.length > 0 || submitting || busy}
          >
            <Send aria-hidden="true" /> {submitting ? "Working…" : `${submitLabel}${pendingList.length ? ` (${pendingList.length})` : ""}`}
          </Button>
        </div>
      </div>

      {overlaps.length > 0 && (
        <p className="text-xs text-warning" role="alert">
          In {overlaps.join(", ")} two changes touch the same cells: the total and a row beneath it, or Plan and Price change on
          one row. They are applied one after the other, so the second would overwrite the first. Keep one of them.
        </p>
      )}
      {message && (
        <p className={cn("text-xs", message.ok ? "text-positive" : "text-negative")} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      <div
        ref={gridRef}
        tabIndex={0}
        role="grid"
        aria-label={caption ?? "Planning grid"}
        aria-rowcount={lines.length}
        aria-colcount={columns.length + 1}
        onKeyDown={onGridKeyDown}
        onCopy={copySelection}
        onPaste={pasteIntoGrid}
        className="relative max-h-[560px] overflow-auto rounded-lg border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-20">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-30 min-w-[240px] border-b border-r border-border bg-card px-3 py-2 text-left text-[11px] font-medium uppercase text-text-tertiary"
              >
                {caption ?? "Node"}
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "min-w-[84px] border-b border-border bg-card px-2 py-2 text-right text-[11px] font-medium text-text-tertiary",
                    column.kind !== "week" && "bg-muted",
                  )}
                >
                  {column.kind === "week" ? column.label.replace(/^\d{4}-/, "") : column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, lineIdx) => {
              const row = rowByKey.get(line.rowKey);
              const isOpen = expanded.has(line.rowKey);
              return (
                <tr key={`${line.rowKey}|${line.measure.code}`} aria-rowindex={lineIdx + 2}>
                  <th
                    scope="row"
                    className={cn(
                      "sticky left-0 z-10 border-b border-r border-border bg-card px-3 py-1.5 text-left font-normal",
                      line.isTotal && !line.isSub && "font-semibold",
                    )}
                  >
                    {line.isSub ? (
                      <span className="block pl-6 text-text-tertiary" title={line.measure.description ?? undefined}>
                        {line.measure.label}
                        <span className="ml-1 text-[10px]">({line.measure.unit})</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggle(line.rowKey)}
                          className="rounded p-0.5 text-text-tertiary hover:text-foreground"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Hide" : "Show"} drivers and value for ${line.rowLabel}`}
                        >
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                        <span
                          className={cn("truncate", row?.writeBlock && "text-text-tertiary")}
                          title={row?.writeBlock ? `${line.rowLabel}. ${row.writeBlock}` : line.rowLabel}
                        >
                          {line.rowLabel}
                        </span>
                        {row?.writeBlock && <Lock size={10} className="shrink-0 text-text-tertiary" aria-label={row.writeBlock} />}
                        {row && row.leafCount > 0 && !line.isTotal && (
                          <span className="ml-auto text-[10px] text-text-tertiary">{line.measure.label}</span>
                        )}
                      </span>
                    )}
                  </th>
                  {columns.map((column, colIdx) => {
                    const { value, isPending } = shownValue(line, column);
                    const editable = cellEditable(line, column);
                    const isActive = active?.line === lineIdx && active?.col === colIdx;
                    const selected = inSelection(lineIdx, colIdx);
                    const lockedShare = row?.locked[column.key] ?? 0;
                    const inFill = fill && fill.line === lineIdx && colIdx >= Math.min(fill.from, fill.to) && colIdx <= Math.max(fill.from, fill.to);
                    return (
                      <td
                        key={column.key}
                        id={`grid-cell-${lineIdx}-${colIdx}`}
                        role="gridcell"
                        aria-selected={selected}
                        aria-readonly={!editable}
                        data-grid-line={lineIdx}
                        data-grid-col={colIdx}
                        onPointerDown={(event) => {
                          if (editing) commitEditing(null);
                          if (event.shiftKey && active) moveTo(lineIdx, colIdx, true);
                          else moveTo(lineIdx, colIdx, false);
                          gridRef.current?.focus();
                        }}
                        onDoubleClick={() => {
                          if (editable) startEditing(undefined, { line: lineIdx, col: colIdx });
                        }}
                        className={cn(
                          "relative border-b border-border px-2 py-1.5 text-right tabular-nums",
                          column.kind !== "week" && "bg-muted font-medium",
                          line.isSub && "text-text-tertiary",
                          line.isTotal && !line.isSub && "font-semibold",
                          editable && "cursor-cell",
                          isPending && "bg-accent-subtle text-accent",
                          selected && !isActive && "bg-accent-subtle/60",
                          inFill && "bg-accent-subtle",
                          isActive && "outline outline-2 -outline-offset-2 outline-accent",
                        )}
                      >
                        {isActive && editing ? (
                          <input
                            ref={editorRef}
                            value={editing.text}
                            onChange={(event) => setEditing({ text: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitEditing({ line: lineIdx + (event.shiftKey ? -1 : 1), col: colIdx });
                              } else if (event.key === "Tab") {
                                event.preventDefault();
                                commitEditing({ line: lineIdx, col: colIdx + (event.shiftKey ? -1 : 1) });
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelEditing();
                              }
                            }}
                            onBlur={() => commitEditing(null)}
                            aria-label={`${line.rowLabel}, ${line.measure.label}, ${column.label}`}
                            className="w-full min-w-[70px] rounded-sm border border-accent bg-background px-1 text-right outline-none"
                          />
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            {lockedShare > 0 && column.kind === "week" && !line.isSub && (
                              <Lock
                                size={10}
                                className="text-text-tertiary"
                                aria-label={lockedShare >= 1 ? "Locked" : `${Math.round(lockedShare * 100)}% of cells locked`}
                              />
                            )}
                            {formatValue(value, line.measure.unit)}
                          </span>
                        )}
                        {isActive && editable && !editing && (
                          <span
                            role="presentation"
                            onPointerDown={(event) => beginFillDrag(event, lineIdx, colIdx)}
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              fillToEnd(lineIdx, colIdx);
                            }}
                            title="Drag to fill; double-click to fill to the end of the horizon"
                            className="absolute bottom-0 right-0 h-2 w-2 translate-x-1/2 translate-y-1/2 cursor-crosshair rounded-[1px] bg-accent"
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-tertiary">
        <span>
          {rangeSummary
            ? `${rangeSummary.count} cells${rangeSummary.sum !== null ? ` · sum ${formatValue(rangeSummary.sum, rangeSummary.unit ?? "units")}` : ""} · mean ${formatValue(rangeSummary.mean, rangeSummary.unit ?? "units")}`
            : "Shift-click or Shift+arrows to select a range. Enter to edit, Delete to clear a pending change, Cmd/Ctrl+Z to undo."}
        </span>
        <span>
          Factors are an ordered decomposition (events, promotions, streams, planner): exact, not independent causes.
        </span>
      </div>
    </div>
  );
}
