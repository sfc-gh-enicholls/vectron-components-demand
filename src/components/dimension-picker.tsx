"use client";

/**
 * DimensionPicker: one dimension (product, customer or channel) picked as a tree.
 *
 * The Siemens IBP pattern: a single trigger per dimension showing the selected
 * node, its breadcrumb beneath, and a panel holding the whole tree with
 * explicit expand toggles. Any node at any depth can be chosen, so "Cognac",
 * "Martell" and "Total portfolio" are all one click from the same control.
 *
 * Where a dimension has several trees over the same leaves (category, product
 * family, price tier), the panel offers them as tabs. Switching a tab only
 * changes what is being browsed; choosing a node commits both the node and the
 * tree it was chosen in, which is the roll-up the rest of the app reads.
 *
 * Keyboard: native buttons throughout, Escape closes and returns focus to the
 * trigger, and a click or focus outside the picker closes it.
 */

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { children as childrenOf, pathTo, type HierarchyDef, type HNode } from "@/lib/dimensions";
import { cn } from "@/lib/utils";

const byLabel = (left: HNode, right: HNode) => left.label.localeCompare(right.label, "en-GB");

export function DimensionPicker({
  label,
  trees,
  treeId,
  nodeId,
  allowed,
  onSelect,
}: {
  label: string;
  /** Every tree of this dimension, default first. */
  trees: HierarchyDef[];
  /** The tree the current selection lives in. */
  treeId: string;
  /** The selected node in that tree; the root when nothing is chosen. */
  nodeId: string;
  /** Node ids to offer per tree; null offers the whole tree. */
  allowed: (tree: HierarchyDef) => Set<string> | null;
  onSelect: (tree: HierarchyDef, node: HNode) => void;
}) {
  const id = React.useId();
  const ref = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [browse, setBrowse] = React.useState(treeId);
  const current = trees.find((tree) => tree.id === treeId) ?? trees[0];
  const ready = Boolean(current?.nodes?.length);
  const trail = ready ? pathTo(current.nodes!, nodeId) : [];
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  // The panel is fixed to the trigger rather than absolutely positioned, because
  // the cards this sits in clip their overflow.
  const [anchor, setAnchor] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const place = React.useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (box) setAnchor({ top: box.bottom + 4, left: box.left, width: box.width });
  }, []);

  const openPanel = () => {
    setBrowse(current.id);
    setExpanded(new Set(trail.map((node) => node.id)));
    place();
    setOpen(true);
  };
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const shown = trees.find((tree) => tree.id === browse) ?? current;
  const nodes = shown?.nodes ?? [];
  const offer = shown ? allowed(shown) : null;
  const kidsOf = (node: string) =>
    childrenOf(nodes, node).filter((kid) => !offer || offer.has(kid.id)).sort(byLabel);
  const toggle = (node: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });

  const render = (node: HNode, depth: number): React.ReactNode => {
    const kids = kidsOf(node.id);
    const isOpen = expanded.has(node.id);
    const selected = shown.id === current.id && node.id === nodeId;
    return (
      <li key={node.id}>
        <div className="tree-row" style={{ "--depth": depth } as React.CSSProperties}>
          {kids.length > 0 ? (
            <button
              type="button"
              className="tree-toggle"
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.label}`}
              aria-expanded={isOpen}
              onClick={() => toggle(node.id)}
            >
              {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            </button>
          ) : (
            <span className="tree-spacer" />
          )}
          <button
            type="button"
            className={cn("tree-select", selected && "selected")}
            aria-current={selected ? "true" : undefined}
            onClick={() => {
              onSelect(shown, node);
              dismiss();
            }}
          >
            {node.label}
          </button>
        </div>
        {kids.length > 0 && isOpen && <ul>{kids.map((kid) => render(kid, depth + 1))}</ul>}
      </li>
    );
  };

  const root = nodes.find((node) => node.parent === null);
  const value = trail.at(-1)?.label ?? current?.rootLabel ?? label;
  const breadcrumb = trail.length > 1
    ? trail.slice(1, -1).map((node) => node.label).join(" › ") || current.name
    : current?.name ?? "";

  return (
    <div
      className="tree-picker"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          dismiss();
        }
      }}
      onBlur={(event) => {
        if (open && event.relatedTarget && !ref.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <span className="tree-label" aria-hidden>{label}</span>
      <button
        type="button"
        ref={trigger}
        className="tree-trigger"
        aria-label={`${label}: ${value}`}
        aria-describedby={`${id}-trail`}
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        disabled={!ready}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span>{value}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <span className="tree-trail" id={`${id}-trail`}>{breadcrumb}</span>
      {open && shown && root && (
        <div
          className="tree-panel"
          id={`${id}-panel`}
          role="group"
          aria-label={`${label} hierarchy`}
          style={anchor ? { top: anchor.top, left: anchor.left, width: Math.max(anchor.width, 300), maxHeight: `min(380px, calc(100vh - ${anchor.top + 16}px))` } : undefined}
        >
          {trees.length > 1 && (
            <div className="tree-tabs" role="group" aria-label={`Browse ${label.toLowerCase()} by`}>
              {trees.map((tree) => (
                <button
                  key={tree.id}
                  type="button"
                  aria-pressed={tree.id === shown.id}
                  title={tree.description ?? undefined}
                  onClick={() => {
                    setBrowse(tree.id);
                    setExpanded(new Set([...(tree.id === current.id ? trail.map((node) => node.id) : []), tree.id]));
                  }}
                >
                  {tree.name}
                </button>
              ))}
            </div>
          )}
          <ul>{render(root, 0)}</ul>
        </div>
      )}
    </div>
  );
}
