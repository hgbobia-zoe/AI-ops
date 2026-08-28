import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy Node packages used only in server code (route handlers,
  // ingestion). Keep them out of the bundle so they load from node_modules.
  serverExternalPackages: ["better-sqlite3", "playwright"],
};

export default nextConfig;
