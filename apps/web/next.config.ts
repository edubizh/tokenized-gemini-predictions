import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const config: NextConfig = {
  // The app lives in a pnpm workspace; point both resolvers at the workspace root.
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@outcome/program-client"],
};

export default config;
