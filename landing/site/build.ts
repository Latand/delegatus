/*
 * Builds the landing into landing/site/dist/, a static site with no server:
 *
 *   bun landing/site/build.ts
 *
 * The page itself is plain HTML, CSS and classic scripts. The demo inside it
 * is the real Delegatus Viewer: demo/demo.tsx is bundled for the browser with
 * the product's own components, and the product's stylesheet
 * (src/app/globals.css) is compiled through Tailwind the way the Viewer's build
 * compiles it, then pinned to the dark palette. A `"use server"` module becomes
 * an async stub answering an empty record, as Next replaces it in a client
 * bundle, so no server code reaches the page.
 */
import fs from "node:fs";
import path from "node:path";

import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";

import { taskIconNodes } from "@/lib/tasks/taskIconNodes";
import { ROLE_FRAME_BOOT_SCRIPT } from "@/lib/roleFrames";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, "../..");
const dist = path.join(here, "dist");
process.chdir(repo);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "demo"), { recursive: true });
fs.mkdirSync(path.join(dist, "brand"), { recursive: true });

/* The task icons the demo's cards draw, which the Viewer asks a route for. */
const ICONS = ["file-text", "key-round", "repeat", "book-open", "list-ordered", "receipt-text", "layout-grid", "calculator", "wifi-off", "gauge"];
fs.writeFileSync(path.join(here, "demo/taskIcons.json"), `${JSON.stringify(await taskIconNodes(ICONS))}\n`);

const SERVER_DIRECTIVE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use server["']/;
const bundle = await Bun.build({
  entrypoints: [path.join(here, "demo/demo.tsx")],
  outdir: path.join(dist, "demo"),
  target: "browser",
  minify: process.env.DEMO_DEBUG !== "1",
  naming: "[name].[ext]",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [{
    name: "server-action-stubs",
    setup(build) {
      build.onLoad({ filter: /\/src\/.*\.tsx?$/ }, (args) => {
        const source = fs.readFileSync(args.path, "utf8");
        const loader = args.path.endsWith(".tsx") ? "tsx" : "ts";
        if (!SERVER_DIRECTIVE.test(source)) return { contents: source, loader };
        const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|let)\s+(\w+)/gm)].map((match) => match[1]);
        return { contents: names.map((name) => `export async function ${name}() { return {}; }`).join("\n"), loader: "ts" };
      });
    },
  }],
});
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log);
  process.exit(1);
}

/* The product's stylesheet, always in its dark palette: the demo sits on a dark page. */
const globals = path.join(repo, "src/app/globals.css");
const compiled = await postcss([tailwind()]).process(fs.readFileSync(globals, "utf8"), { from: globals });
fs.writeFileSync(path.join(dist, "demo/viewer.css"), compiled.css.replaceAll("(prefers-color-scheme: dark)", "all").replaceAll("(prefers-color-scheme:dark)", "all"));

fs.writeFileSync(path.join(dist, "demo/index.html"), `<!doctype html>
<html lang="en" class="h-full antialiased" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Delegatus demo</title>
<script>${ROLE_FRAME_BOOT_SCRIPT}</script>
<link rel="stylesheet" href="viewer.css">
<style>html,body{background:var(--color-canvas)}</style>
</head>
<body class="h-dvh overflow-hidden font-sans text-[15px]">
<div id="root" style="height:100dvh;display:flex;flex-direction:column"></div>
<script type="module" src="demo.js"></script>
</body>
</html>
`);

/* The page, with its repository-relative references rewritten to local copies. */
for (const file of ["index.html", "styles.css", "copy.js", "mascot.js", "main.js"]) {
  let text = fs.readFileSync(path.join(here, file), "utf8");
  for (const match of text.matchAll(/\.\.\/\.\.\/public\/brand\/([\w.-]+)/g)) {
    fs.copyFileSync(path.join(repo, "public/brand", match[1]!), path.join(dist, "brand", match[1]!));
  }
  text = text.split("../../public/brand/").join("brand/");
  fs.writeFileSync(path.join(dist, file), text);
}

const size = (file: string) => `${Math.round(fs.statSync(path.join(dist, file)).size / 1024)} KB`;
console.log(`landing/site/dist: demo.js ${size("demo/demo.js")}, viewer.css ${size("demo/viewer.css")}`);
