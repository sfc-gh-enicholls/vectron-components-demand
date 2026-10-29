import { query } from "@/lib/snowflake";

/**
 * A cheap fingerprint of the tables a read depends on: each table's last
 * commit time (SYSTEM$LAST_CHANGE_COMMIT_TIME reads metadata, no scan). Any
 * insert, update, delete or rebuild of one of them changes the fingerprint,
 * so a result cached under it is exact for as long as it is reused.
 *
 * Table names are constants from this codebase, never request input.
 */
export async function dataVersion(tables: readonly string[]): Promise<string> {
  const sql =
    "SELECT " +
    tables.map((t) => `SYSTEM$LAST_CHANGE_COMMIT_TIME('VECTRON_DEMAND.${t}')`).join(" || '/' || ") +
    " AS V";
  const rows = await query<{ V: string }>(sql);
  return rows[0]?.V ?? "";
}

/**
 * A small in-process cache of query results keyed by (request key, data
 * version). Oldest entries are dropped past `limit`. Concurrent misses for the
 * same key share one load.
 */
export function versionedCache<T>(limit: number) {
  const entries = new Map<string, { version: string; value: Promise<T> }>();
  return async (key: string, version: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && hit.version === version) return hit.value;
    const value = load();
    entries.delete(key);
    entries.set(key, { version, value });
    while (entries.size > limit) entries.delete(entries.keys().next().value as string);
    // A failed load must not be served from the cache.
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
