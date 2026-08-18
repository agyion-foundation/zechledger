import path from "node:path";

export function getDataDirectory(): string {
  const configured = process.env.ZECHLEDGER_DATA_DIR || ".zechledger";
  return path.isAbsolute(configured) ? configured : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
}
