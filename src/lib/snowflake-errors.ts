// Shared helpers for handling Snowflake errors.
// Primarily used to gracefully handle endpoints whose underlying tables may
// not exist yet because the migration hasn't been run.

export function isMissingObjectError(err: unknown, tableName?: string): boolean {
  const msg = String((err as Error).message || "").toUpperCase();
  // Snowflake "does not exist" errors typically mention the object name and
  // one of these phrases. The explicit tableName is an optional extra hint
  // — useful when a shared error string like "INVALID IDENTIFIER" could
  // also be triggered by a column-name typo.
  if (tableName && msg.includes(tableName.toUpperCase())) return true;
  return msg.includes("DOES NOT EXIST");
}
