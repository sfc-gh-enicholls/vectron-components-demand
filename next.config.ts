import type { NextConfig } from "next";

// One codebase, two hosts. STATIC_COPY=1 builds the read-only GitHub Pages copy:
// a static export served from the repo sub-path, whose pages read recorded API
// responses (scripts/static/publish-pages.sh). Otherwise a standalone server for
// SPCS / local use against live Snowflake.
const isStatic = process.env.STATIC_COPY === "1";
const basePath = isStatic ? `/${process.env.PAGES_REPO ?? "vectron-demand-demo"}` : "";

const nextConfig: NextConfig = {
  output: isStatic ? "export" : "standalone",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_STATIC_COPY: isStatic ? "1" : "" },
  // The dev-only "N" badge sat over the nav footer in screenshots and demos.
  devIndicators: false,
  serverExternalPackages: ["snowflake-sdk"],
  ...(isStatic
    ? {}
    : {
        experimental: {
          serverActions: {
            allowedOrigins: ["*.snowflakecomputing.app", "localhost:3000"],
          },
        },
      }),
};

export default nextConfig;
