import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { linePersonalBrowserPlugins } from "./line-personal-browser-build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "tmp/line-personal-probe/extension");
await mkdir(output, { recursive: true });
await cp(path.join(root, "extension"), output, { recursive: true });
await cp(path.join(root, "tools/line-personal-probe/connection.html"), path.join(output, "line-personal-probe.html"));

const manifestPath = path.join(output, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.name = "Omnichat Bridge · LINE Personal development probe";
manifest.host_permissions = [...new Set([
  ...manifest.host_permissions,
  "https://legy.line-apps.com/*",
  "https://gf.line.naver.jp/*",
  "https://obs.line-apps.com/*",
])];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const popupPath = path.join(output, "popup.html");
const popup = await readFile(popupPath, "utf8");
await writeFile(popupPath, popup.replace("</body>", '<p><a href="line-personal-probe.html" target="_blank" rel="noopener">Open LINE Personal development probe</a></p>\n</body>'));

await build({
  absWorkingDir: root,
  entryPoints: ["tools/line-personal-probe/connection.js"],
  outfile: path.join(output, "line-personal-probe.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  minify: true,
  legalComments: "inline",
  define: { "globalThis.process": "undefined" },
  plugins: linePersonalBrowserPlugins(),
});

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
console.log(`Development build ready: ${output}`);
console.log("Load this existing-extension development build unpacked, then open its popup → LINE Personal development probe.");
console.log("No authentication or forwarding was started by this build.");
