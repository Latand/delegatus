// Assembles a self-contained copy of the page in landing/opus/dist/ for a
// static host (Cloudflare Pages, `bunx serve landing/opus/dist`). The source
// page reads the README captures and the emblem in place from the repository,
// so nothing is duplicated in git; this copies the files it references and
// rewrites the two relative prefixes. Run: bun landing/opus/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const dist = join(here, "dist");
const prefixes = [
  ["../../docs/media/readme/", "media/", join(repo, "docs/media/readme")],
  ["../../public/brand/", "brand/", join(repo, "public/brand")],
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copied = new Set();
for (const file of ["index.html", "styles.css", "copy.js", "mascot.js", "main.js"]) {
  let text = readFileSync(join(here, file), "utf8");
  for (const [from, to, source] of prefixes) {
    for (const match of text.matchAll(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([\\w.-]+)`, "g"))) {
      const name = match[1];
      if (copied.has(to + name)) continue;
      mkdirSync(join(dist, to), { recursive: true });
      cpSync(join(source, name), join(dist, to, name));
      copied.add(to + name);
    }
    text = text.split(from).join(to);
  }
  writeFileSync(join(dist, file), text);
}
console.log(`landing/opus/dist: 5 page files, ${copied.size} assets (${[...copied].join(", ")})`);
