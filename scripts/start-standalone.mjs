#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

await mkdir(".next/standalone/.next", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true, force: true });
await cp("public", ".next/standalone/public", { recursive: true, force: true });

const child = spawn(process.execPath, [".next/standalone/server.js"], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
