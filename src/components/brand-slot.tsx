/**
 * BrandSlot — the top of the nav, driven entirely by src/brand/active.json.
 *
 * Snowflake host: the sub-brand lockup from the brand guidelines (logo, thin
 * rule, two-line caps label). Both logo colours are rendered and the mode
 * picks one through .only-light / .only-dark, so the swap needs no script.
 * Any other host: its own logo files or a wordmark. A re-skin edits the brand
 * file, never this component.
 */

import brand from "@/brand/active.json";
import { asset } from "@/lib/base-path";

type Slot =
  | { type: "snowflake-lockup"; label: string[] }
  | { type: "logo"; light: string; dark: string }
  | { type: "wordmark"; text: string; sub?: string };

export function BrandSlot() {
  const slot = brand.brandSlot as Slot;
  return (
    <div className="brand">
      {slot.type === "snowflake-lockup" && (
        <>
          <img className="only-light" src={asset("/ui/logo/snowflake-logo-blue.png")} alt="Snowflake" />
          <img className="only-dark" src={asset("/ui/logo/snowflake-logo-white.png")} alt="Snowflake" />
          <span className="rule" aria-hidden="true" />
          <span className="dept">
            {slot.label.map((line) => (
              <span key={line} className="block">{line}</span>
            ))}
          </span>
        </>
      )}
      {slot.type === "logo" && (
        <>
          <img className="host-logo only-light" src={asset(slot.light)} alt={brand.appName} />
          <img className="host-logo only-dark" src={asset(slot.dark)} alt={brand.appName} />
        </>
      )}
      {slot.type === "wordmark" && (
        <div>
          <div className="wordmark">{slot.text}</div>
          {slot.sub ? <div className="wordmark-sub">{slot.sub}</div> : null}
        </div>
      )}
    </div>
  );
}
