// esbuild driver for the browser-bridge MV3 extension.
//
// Bundles src/*.ts → dist/*.js (IIFE, unminified so the unpacked extension
// stays debuggable) and copies the static assets (manifest, HTML, CSS, icons)
// alongside. The load-unpacked target is extension/dist/.
//
//   node build.mjs          one-shot build
//   node build.mjs --watch  rebuild on change

import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, "dist");
const watch = process.argv.includes("--watch");

const STATIC_FILES = ["manifest.json", "popup.html", "options.html", "toast.css"];

function copyStatic() {
  for (const f of STATIC_FILES) cpSync(join(root, f), join(outdir, f));
  cpSync(join(root, "icons"), join(outdir, "icons"), { recursive: true });
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [
    join(root, "src/background.ts"),
    join(root, "src/content.ts"),
    join(root, "src/options.ts"),
    join(root, "src/popup.ts"),
  ],
  bundle: true,
  outdir,
  format: "iife",
  target: "chrome116",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  copyStatic();
  console.log("[build] watching src/ …");
} else {
  await esbuild.build(options);
  copyStatic();
  console.log("[build] done → extension/dist/");
}
