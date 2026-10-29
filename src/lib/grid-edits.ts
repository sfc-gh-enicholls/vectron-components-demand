/**
 * Pure helpers for the planning grid's edit buffer.
 *
 * Replaces two things in SDP's TimePlanningGrid: its input parser ran the
 * typed text through `Function(...)` and rounded every value to an integer
 * (fatal for factors and shares), and it had no check for edits that fight
 * each other. Typed arithmetic is evaluated by the formula parser instead,
 * which accepts numbers, + - * / and parentheses, and nothing else.
 */
import { evaluate, parseExpression } from "@/lib/calc-engine";

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, bn: 1e9, b: 1e9 };

/**
 * Parse what a planner typed into a cell. Returns null when it is not a
 * number or simple arithmetic. "5%" -> 0.05; "12k" -> 12000; "1200*1.05" -> 1260.
 */
export function parseGridInput(raw: string): number | null {
  let text = raw.trim().toLowerCase().replace(/,/g, "");
  if (!text) return null;
  let scale = 1;
  if (text.endsWith("%")) {
    scale = 0.01;
    text = text.slice(0, -1).trim();
  }
  // Number suffixes, applied before parsing so "1.5m * 2" works.
  text = text.replace(/(\d+(?:\.\d+)?)\s*(bn|b|m|k)\b/g, (_, num: string, suffix: string) =>
    String(Number(num) * SUFFIX[suffix]),
  );
  if (!/^[\d.\s+\-*/()]+$/.test(text)) return null;
  const parsed = parseExpression(text);
  if (!parsed.ast || parsed.refs.length > 0) return null;
  const value = evaluate(parsed.ast, new Map()) * scale;
  return Number.isFinite(value) ? value : null;
}

export interface GridEdit {
  rowKey: string;
  /** The selected node's own row, as opposed to one of its children. */
  isTotal: boolean;
  weekId: string;
  measure: string;
  value: number;
  /** The value shown before the edit, for undo and for the preview's "from". */
  previous: number | null;
}

/**
 * Weeks where two edits in the batch touch the same leaves: the node total and
 * a row beneath it, or two measures on the same row (a Plan edit and a Price
 * change). Edits are applied one after another, so the later would overwrite
 * part of the earlier and the preview, which shows each against today's
 * numbers, would not be what is written. Such a batch is refused instead.
 * Sibling rows, and different weeks, never clash.
 */
export function findOverlaps(edits: GridEdit[]): string[] {
  const clashes = new Set<string>();
  const byWeek = new Map<string, GridEdit[]>();
  for (const edit of edits) byWeek.set(edit.weekId, [...(byWeek.get(edit.weekId) ?? []), edit]);
  for (const [weekId, weekEdits] of byWeek) {
    const hasTotal = weekEdits.some((edit) => edit.isTotal);
    const hasChild = weekEdits.some((edit) => !edit.isTotal);
    const rowsSeen = new Set<string>();
    let sameRowTwice = false;
    for (const edit of weekEdits) {
      if (rowsSeen.has(edit.rowKey)) sameRowTwice = true;
      rowsSeen.add(edit.rowKey);
    }
    if ((hasTotal && hasChild) || sameRowTwice) clashes.add(weekId);
  }
  return [...clashes].sort();
}

export function editKey(edit: Pick<GridEdit, "rowKey" | "weekId" | "measure">): string {
  return `${edit.rowKey}|${edit.measure}|${edit.weekId}`;
}
