import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { linePersonalBrowserPlugins } from "./line-personal-browser-build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outIndex = process.argv.indexOf("--outdir");
const output = path.resolve(root, outIndex >= 0 ? process.argv[outIndex + 1] : "tmp/extension");
const relative = path.relative(path.join(root, "tmp"), output);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Build output must be a generated directory below tmp/.");
const debug = process.argv.includes("--debug-probe");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "extension"), output, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["extension/line-personal-client.js"],
  outfile: path.join(output, "line-personal-client.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome120",
  minify: true,
  legalComments: "inline",
  define: { "globalThis.process": "undefined" },
  plugins: linePersonalBrowserPlugins(),
});

if (debug) {
  await cp(path.join(root, "tools/line-personal-probe/connection.html"), path.join(output, "line-personal-probe.html"));
  await build({ absWorkingDir: root, entryPoints: ["tools/line-personal-probe/connection.js"],
    outfile: path.join(output, "line-personal-probe.js"), bundle: true, platform: "browser", format: "iife",
    target: "chrome120", minify: true, legalComments: "inline",
    define: { "globalThis.process": "undefined" }, plugins: linePersonalBrowserPlugins() });
}

// Include the installed packages' exact copyright/license files in the local
// artifact, including transitive bundled dependencies. No registry fetch here.
const packages = path.join(root, "node_modules/.pnpm");
const { readdir } = await import("node:fs/promises");
const notices = [];
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  const modules = path.join(packages, entry.name, "node_modules");
  for (const module of await readdir(modules, { withFileTypes: true })) {
    if (!module.isDirectory()) continue;
    const candidates = module.name.startsWith("@")
      ? (await readdir(path.join(modules, module.name))).map((name) => path.join(modules, module.name, name))
      : [path.join(modules, module.name)];
    for (const candidate of candidates) {
      for (const filename of await readdir(candidate)) {
        if (!/^(licen[sc]e|copying|notice)(\.|$)/i.test(filename)) continue;
        const contents = await readFile(path.join(candidate, filename), "utf8");
        notices.push(`## ${path.relative(packages, candidate)} / ${filename}\n\n${contents}`);
      }
    }
  }
}
await writeFile(path.join(output, "LINE_PERSONAL_THIRD_PARTY_NOTICES.txt"), notices.join("\n\n"));
console.log(`Extension build ready: ${output}`);
console.log("Load this directory unpacked. LINE Personal appears in the provider selector only with its account configuration.");
console.log("No authentication or forwarding was started by this build.");
