"use client";

/**
 * PageBanner — the slim header band at the top of every screen.
 *
 * Follows the snowflake-app-branding skill: one line, the screen title in
 * display caps with its last word highlighted, the play's pillar steps on the
 * right (the current screen's pillar marked), and the dot patch. Colours come
 * from the --band-* and --step-* tokens, so the band is Snowflake Blue in light
 * mode, Iceberg in dark, and whatever a re-skin's host says.
 *
 * THE PROPS DID NOT CHANGE
 * ------------------------
 * Every page still passes eyebrow, headline, subtitle, metadata, link and the
 * collapse flags. Nothing a page passed is dropped: the band holds the
 * headline; the eyebrow, metadata, subtitle and link sit on one line below it,
 * and `collapsible` still hides that line. `icon` is accepted and not drawn:
 * the band carries no illustration, and the same icon is beside the screen's
 * name in the nav. `headlineSize` and `eyebrowSize` are accepted for
 * compatibility; the band has one size by design.
 */

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { currentPillar } from "@/components/app-shell";
import brand from "@/brand/active.json";

interface BannerLink {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface PageBannerProps {
  eyebrow: string;
  headline: string;
  subtitle?: string;
  link?: BannerLink;
  icon?: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
  headlineSize?: "default" | "large";
  eyebrowSize?: "default" | "large";
  /** Inline meta-info (e.g. cycle + steps counter), shown under the band. */
  metadata?: React.ReactNode;
}

/** The dot patch: a 15 × 12 grid at 7px pitch, sized to the 30px title. */
const DOTS: { x: number; y: number }[] = [];
for (let row = 0; row < 12; row++) {
  for (let col = 0; col < 15; col++) DOTS.push({ x: 5 + col * 7, y: 5 + row * 7 });
}

function BandTitle({ text }: { text: string }) {
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return <h1><span className="hl">{text}</span></h1>;
  const last = words.pop();
  return <h1><span>{words.join(" ")}</span> <span className="hl">{last}</span></h1>;
}

function Steps({ current }: { current: string | null }) {
  const at = current ? brand.steps.indexOf(current) : -1;
  return (
    <div className="steps" aria-label="Planning stages">
      {brand.steps.map((step, i) => {
        const state = at < 0 ? "fut" : i < at ? "done" : i === at ? "cur" : "fut";
        return (
          <React.Fragment key={step}>
            {i > 0 && (
              <svg className="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            )}
            <span className={cn("step", state)} aria-current={state === "cur" ? "step" : undefined}>
              {state === "done" && (
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
              )}
              {step}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function PageBanner({
  eyebrow,
  headline,
  subtitle,
  link,
  collapsible = false,
  defaultCollapsed = false,
  className,
  metadata,
}: PageBannerProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const pathname = usePathname();
  const hasDetail = Boolean(eyebrow || metadata || subtitle || link);

  return (
    <div className={className}>
      <section className="band">
        <svg className="band-deco" viewBox="0 0 112 90" aria-hidden="true">
          <g opacity=".35">
            {DOTS.map((d) => <circle key={`${d.x}-${d.y}`} className="dot" cx={d.x} cy={d.y} r="1.1" />)}
          </g>
        </svg>
        <BandTitle text={headline} />
        <Steps current={currentPillar(pathname)} />
      </section>

      {hasDetail && (
        <div className="mt-3 flex items-start gap-3 px-1">
          {!collapsed && (
            <div className="min-w-0 flex-1 text-[13px] leading-[1.5] text-text-tertiary">
              <span className="label mr-2">{eyebrow}</span>
              {metadata ? <span className="mr-2">{metadata}</span> : null}
              {subtitle ? <span className="mr-2">{subtitle}</span> : null}
              {link && (
                link.href ? (
                  <a href={link.href} onClick={link.onClick} className="font-bold text-title-ink hover:underline">
                    {link.label}{"  "}›
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={link.onClick}
                    className="cursor-pointer border-0 bg-transparent p-0 font-bold text-title-ink hover:underline"
                  >
                    {link.label}{"  "}›
                  </button>
                )
              )}
            </div>
          )}
          {collapsed && <div className="flex-1" />}
          {collapsible && (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="rounded p-1 text-text-tertiary hover:text-foreground"
              aria-label={collapsed ? "Expand banner" : "Collapse banner"}
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
