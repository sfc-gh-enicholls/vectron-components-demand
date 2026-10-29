"use client";

/**
 * AppShell — Snowflake industry-app chrome around every screen.
 *
 * Layout follows the snowflake-app-branding skill: a 256px nav with the brand
 * slot and the play's pillar sections, then a 64px top bar with breadcrumb,
 * scenario, freshness, the light/dark toggle and the persona. Classes come from
 * public/ui/components.css; every host string comes from src/brand/active.json.
 *
 * WHAT DID NOT CHANGE
 * -------------------
 * The routes, their order, labels, icons and hints, the skip link, and the
 * mobile drawer (open/close button below lg). The persona switcher is the same
 * component with the same behaviour; it moved from the nav footer to the top
 * bar, where the skill puts the persona so it is always visible.
 *
 * The old three-way theme cycle (dark / light / editorial) is replaced by the
 * mode toggle. Editorial lives on as its own host: see public/ui/themes.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, LineChart, ClipboardCheck, RadioTower, FlaskConical,
  Target, Network, Sprout, Bot, Menu, X,
  BarChart3, Truck, Car, Wrench, Coins, Stamp, GitBranch, Factory,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonaSwitcher } from "@/components/persona-switcher";
import { ModeToggle } from "@/components/mode";
import { BrandSlot } from "@/components/brand-slot";
import brand from "@/brand/active.json";
import { asset } from "@/lib/base-path";

/**
 * Navigation follows the planner's actual working order rather than grouping by
 * feature: what needs attention, what the model says, what I decided, then the
 * analytics that judge whether I was right. The brand config groups this order
 * into pillar sections without reordering it.
 */
const NAV = [
  { href: "/",           label: "Cockpit",      icon: LayoutDashboard,
    hint: "Where the week stands" },
  { href: "/sensing",    label: "Demand sensing", icon: RadioTower,
    hint: "0\u20138 week signals" },
  { href: "/calloffs",   label: "OEM call-offs", icon: Truck,
    hint: "EDI schedules vs pull" },
  { href: "/ihs",        label: "Vehicle market", icon: Car,
    hint: "IHS-style production vs plan" },
  { href: "/service",    label: "Service parts", icon: Wrench,
    hint: "Croston for intermittent demand" },
  { href: "/baseline",   label: "Baseline",     icon: LineChart,
    hint: "Statistical forecast and model health" },
  { href: "/review",     label: "Demand review", icon: ClipboardCheck,
    hint: "Exception workbench" },
  { href: "/plan",       label: "Consensus plan", icon: BarChart3,
    hint: "Read and write surface" },
  { href: "/agent",      label: "Agent inbox",   icon: Bot,
    hint: "Recommended actions" },
  { href: "/scenarios",  label: "Scenarios",    icon: FlaskConical,
    hint: "What-if playground" },
  { href: "/approvals",  label: "Approvals",    icon: Stamp,
    hint: "Promotions, inputs, sign-off" },
  { href: "/supply",     label: "Supply review", icon: Factory,
    hint: "Lines, dry goods, allocation" },
  { href: "/value",      label: "Volume to value", icon: Coins,
    hint: "Price and mix bridge" },
  { href: "/accuracy",   label: "Accuracy & FVA", icon: Target,
    hint: "Forecast value add" },
  { href: "/hierarchy",  label: "Hierarchy",    icon: Network,
    hint: "Reconciliation" },
  { href: "/npd",        label: "NPD & lifecycle", icon: Sprout,
    hint: "Launches and phase-out" },
];

type NavItem = (typeof NAV)[number];

function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** Nav items grouped by the brand's pillar sections, in NAV order. */
function navSections(): { label: string; items: NavItem[] }[] {
  const byHref = new Map(NAV.map((item) => [item.href, item]));
  const placed = new Set<string>();
  const sections = brand.navSections.map((section) => ({
    label: section.label,
    items: section.items.flatMap((href) => {
      const item = byHref.get(href);
      if (!item) return [];
      placed.add(href);
      return [item];
    }),
  }));
  // A route missing from the brand file still appears, so no screen can be
  // orphaned by a config edit.
  const rest = NAV.filter((item) => !placed.has(item.href));
  return rest.length > 0 ? [...sections, { label: "More", items: rest }] : sections;
}

/** The pillar the current screen belongs to, for the header band's steps. */
export function currentPillar(pathname: string): string | null {
  for (const section of brand.navSections) {
    if (section.items.some((href) => isActive(href, pathname))) return section.label;
  }
  return null;
}

export function screenLabel(pathname: string): string | null {
  return NAV.find((item) => isActive(item.href, pathname))?.label ?? null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = React.useState(false);
  const sections = React.useMemo(navSections, []);
  const screen = screenLabel(pathname);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Skip link: the first tab stop on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          "nav fixed inset-y-0 left-0 z-40 w-64 transition-transform lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-start justify-between">
          <BrandSlot />
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            className="rounded-md p-1 text-text-tertiary hover:text-foreground lg:hidden"
            aria-label="Close navigation"
          >
            <X size={16} />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Main">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="nav-sec">{section.label}</div>
              <ul>
                {section.items.map((item) => {
                  const active = isActive(item.href, pathname);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setNavOpen(false)}
                        aria-current={active ? "page" : undefined}
                        title={item.hint}
                        className={cn("nav-item", active && "active")}
                      >
                        <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="nav-foot">
          <span>{brand.dataLabel}</span>
          {brand.showBuiltOnSnowflake && (
            <span className="built-on">
              Built on
              <img className="only-light" src={asset("/ui/logo/snowflake-logo-blue.png")} alt="Snowflake" />
              <img className="only-dark" src={asset("/ui/logo/snowflake-logo-white.png")} alt="Snowflake" />
            </span>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:ml-64">
        <header className="top hidden lg:flex">
          <div className="crumb">
            {brand.breadcrumbRoot} / {brand.industry}
            {screen ? <> / <b>{screen}</b></> : null}
          </div>
          <div className="spacer" />
          <div className="pill">
            <GitBranch aria-hidden="true" />
            Scenario · consensus plan
          </div>
          <div className="pill fresh">
            <span className="dot" aria-hidden="true" />
            {brand.freshnessLabel} ·{" "}
            {process.env.NEXT_PUBLIC_STATIC_COPY === "1" ? "recorded copy, read-only" : "read live from Snowflake"}
          </div>
          <ModeToggle />
          <PersonaSwitcher variant="top" />
        </header>

        <header className="flex h-14 items-center gap-3 border-b border-border bg-card px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="rounded-md p-1.5 text-text-tertiary hover:text-foreground"
            aria-label="Open navigation"
          >
            <Menu size={18} />
          </button>
          <span className="text-sm font-bold">{brand.appName}</span>
          <div className="ml-auto flex items-center gap-2">
            <ModeToggle />
          </div>
        </header>
        <div className="border-b border-border bg-card lg:hidden">
          <PersonaSwitcher />
        </div>

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
