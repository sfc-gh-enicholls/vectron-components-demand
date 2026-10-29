import snowflake from "snowflake-sdk";
import fs from "fs";

snowflake.configure({ logLevel: "ERROR" });

let connection: snowflake.Connection | null = null;
let cachedToken: string | null = null;

function getOAuthToken(): string | null {
  const tokenPath = "/snowflake/session/token";
  try {
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, "utf8");
    }
  } catch {
    // Not in SPCS environment
  }
  return null;
}

function getConfig(): snowflake.ConnectionOptions {
  const base = {
    account: process.env.SNOWFLAKE_ACCOUNT || "",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || "COMPUTE_WH",
    database: process.env.SNOWFLAKE_DATABASE || "VECTRON_DEMAND",
    schema: process.env.SNOWFLAKE_SCHEMA || "CORE",
  };

  const token = getOAuthToken();
  if (token) {
    return {
      ...base,
      host: process.env.SNOWFLAKE_HOST,
      token,
      authenticator: "oauth",
    };
  }

  // Local dev: JWT with private key file (matches ~/.snowflake/config.toml pattern)
  const keyPath = process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
  if (keyPath) {
    const privateKey = fs.readFileSync(keyPath, "utf8");
    return {
      ...base,
      username: process.env.SNOWFLAKE_USER || "ENICHOLLS",
      authenticator: "SNOWFLAKE_JWT",
      privateKey,
    };
  }

  return {
    ...base,
    username: process.env.SNOWFLAKE_USER || "ENICHOLLS",
    authenticator: "EXTERNALBROWSER",
  };
}

async function getConnection(): Promise<snowflake.Connection> {
  const token = getOAuthToken();

  if (connection && (!token || token === cachedToken)) {
    return connection;
  }

  if (connection) {
    console.log("OAuth token changed, reconnecting");
    connection.destroy(() => {});
  }

  console.log(
    token ? "Connecting with OAuth token" : "Connecting with external browser"
  );
  const conn = snowflake.createConnection(getConfig());
  await conn.connectAsync((err) => {
    if (err) console.error("Connection callback error:", err.message);
  });
  await new Promise<void>((resolve, reject) => {
    conn.execute({
      sqlText: "ALTER SESSION SET USE_CACHED_RESULT = FALSE",
      complete: (err) => (err ? reject(err) : resolve()),
    });
  });
  connection = conn;
  cachedToken = token;
  return connection;
}

function isRetryableError(err: unknown): boolean {
  const error = err as { message?: string; code?: number };
  return !!(
    error.message?.includes("OAuth access token expired") ||
    error.message?.includes("terminated connection") ||
    error.code === 407002 ||
    error.code === 390195  // session expired
  );
}

let retryInFlight = false;

export async function query<T>(
  sql: string,
  binds?: (string | number | boolean | null)[],
  retries = 1
): Promise<T[]> {
  try {
    const conn = await getConnection();
    return await new Promise<T[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: binds as snowflake.Binds,
        complete: (err, _stmt, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve((rows || []) as T[]);
          }
        },
      });
    });
  } catch (err) {
    console.error("Query error:", (err as Error).message);
    if (retries > 0 && isRetryableError(err) && !retryInFlight) {
      retryInFlight = true;
      connection = null;
      try {
        return await query(sql, binds, retries - 1);
      } finally {
        retryInFlight = false;
      }
    }
    throw err;
  }
}
