import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const config: NextConfig = {
  turbopack: {
    // The app lives in a pnpm workspace; point the resolver at the workspace root.
    root: repoRoot,
    rules: {
      // See loaders/ts-import-extension.cjs.
      "*.ts": {
        condition: { path: /clients\/js\/src\// },
        loaders: [path.join(import.meta.dirname, "loaders/ts-import-extension.cjs")],
        as: "*.ts",
      },
    },
  },
  outputFileTracingRoot: repoRoot,
  // A second server (for example one in fixtures mode beside a live one) needs its own build directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Both are TypeScript source packages from this workspace.
  transpilePackages: ["@outcome/program-client", "@outcome/relayer"],
  // No generated rule files in the app directory.
  agentRules: false,
  // The development indicator floats over the page; the design has no floating elements.
  devIndicators: false,
};

export default config;
