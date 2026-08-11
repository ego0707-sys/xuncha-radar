import { copyFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const workerPath = new URL("../dist/server/index.js", import.meta.url);
workerPath.searchParams.set("pages-export", String(Date.now()));
const { default: worker } = await import(pathToFileURL(workerPath.pathname).href + workerPath.search);

const response = await worker.fetch(
  new Request("https://xuncha-radar.local/", { headers: { accept: "text/html" } }),
  {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  },
  { waitUntil() {}, passThroughOnException() {} },
);

if (!response.ok) throw new Error(`Static export failed with ${response.status}`);
const html = await response.text();
await writeFile(new URL("../dist/client/index.html", import.meta.url), html);
await copyFile(
  new URL("../dist/client/index.html", import.meta.url),
  new URL("../dist/client/404.html", import.meta.url),
);

console.log("Exported GitHub Pages entry files.");
