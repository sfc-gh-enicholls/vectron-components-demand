/**
 * Snowflake-layer components.
 *
 * These mark output that Snowflake itself produced (Cortex narratives, model
 * series). They read only --sf-* / --sfx-* tokens through the skill's `.cx-*`
 * classes, so they look the same in every customer skin, switching only with
 * light and dark. Use them where Snowflake did the work, nowhere else.
 */

export function CortexChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="cx-chip">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 1.5c.7 5.2 3.3 7.8 8.5 8.5-5.2.7-7.8 3.3-8.5 8.5-.7-5.2-3.3-7.8-8.5-8.5 5.2-.7 7.8-3.3 8.5-8.5z" />
        <path d="M19.5 15.5c.3 2 1.3 3 3.3 3.3-2 .3-3 1.3-3.3 3.3-.3-2-1.3-3-3.3-3.3 2-.3 3-1.3 3.3-3.3z" />
      </svg>
      {children}
    </span>
  );
}
