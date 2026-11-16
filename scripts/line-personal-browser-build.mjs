import { fileURLToPath } from "node:url";
import { polyfillNode } from "esbuild-plugin-polyfill-node";

export function linePersonalBrowserPlugins() {
  return [
    {
      name: "line-personal-browser-boundary",
      setup(build) {
        build.onResolve({ filter: /^node:crypto$/ }, () => ({
          path: fileURLToPath(new URL("../extension/lib/line-personal-crypto.js", import.meta.url)),
        }));
        // Undici cannot run in Chrome. LINEJS accepts an explicit browser fetch;
        // fail loudly if a future upstream change attempts its Node-only path.
        build.onResolve({ filter: /^undici$/ }, () => ({ path: "undici", namespace: "browser-unavailable" }));
        build.onLoad({ filter: /.*/, namespace: "browser-unavailable" }, () => ({
          contents: 'export class Agent { constructor() { throw new Error("Node HTTP transport is unavailable in Chrome; provide browser fetch"); } }',
        }));
      },
    },
    polyfillNode({ polyfills: { crypto: true, fs: "empty" } }),
  ];
}
