import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  { rules: { "react-hooks/set-state-in-effect": "off", "react-hooks/purity": "off" } },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "coverage/**",
    "dist/**",
    ".vercel/**",
    ".zechledger/**",
    "jury-video-kling/**",
    "next-env.d.ts",
  ]),
]);
