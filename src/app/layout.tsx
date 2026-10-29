import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModeProvider, type Mode } from "@/components/mode";
import brand from "@/brand/active.json";
import { BASE_PATH } from "@/lib/base-path";

export const metadata: Metadata = {
  title: brand.metaTitle,
  description: brand.metaDescription,
};

const initialMode: Mode = brand.defaultMode === "dark" ? "dark" : "light";

/*
 * Sets the saved mode before CSS paints, so a reload in dark never flashes
 * light. Only a saved choice the host supports is honoured; otherwise the
 * brand's default (already on <html>) stands. Wrapped in try/catch because
 * storage can be blocked. The brand values are JSON-encoded, never spliced in
 * raw.
 */
const prePaint = `(function(){try{var ok=${JSON.stringify(brand.modes)};var m=localStorage.getItem('sf-mode');if(ok.indexOf(m)>-1)document.documentElement.dataset.mode=m;}catch(e){}})();`;

// Set only on the static GitHub Pages copy, which has no server: its fetch shim
// answers /api/* from recorded responses (scripts/static/static-api.js).
const isStaticCopy = process.env.NEXT_PUBLIC_STATIC_COPY === "1";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Host and mode sit on <html>, not <body>: the pre-paint script runs before
    // <body> exists, and every token in tokens.css hangs off these attributes.
    // suppressHydrationWarning because that script may change data-mode before
    // React hydrates.
    <html
      lang={brand.locale}
      data-host={brand.host}
      data-mode={initialMode}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: prePaint }} />
        {isStaticCopy && <script src={`${BASE_PATH}/static-api.js`} data-base={BASE_PATH} />}
      </head>
      <body>
        <ModeProvider modes={brand.modes} defaultMode={initialMode}>
          <TooltipProvider>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
        </ModeProvider>
      </body>
    </html>
  );
}
