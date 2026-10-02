const { execFileSync } = require("node:child_process");

// Dockerfile COPY/install/build inputs. next build also checks TypeScript
// outside src/ and its imported JS/JSON. Tailwind scans src/ (globals.css).
const files = new Set([
  "Dockerfile", ".dockerignore", "package.json", "bun.lock", "bunfig.toml",
  "tsconfig.json", ".github/workflows/docker-image.yml",
  "scripts/whisper_transcribe.py", "scripts/published-image-entrypoint.sh",
]);
const directories = ["src/", "public/", "bin/", "patches/", "vendor/"];

function isImageInput(file) {
  return files.has(file)
    || directories.some(directory => file.startsWith(directory))
    || /^(next|postcss)\.config\./.test(file)
    || /\.(?:[cm]?ts|tsx|[cm]?js|jsx|json)$/.test(file)
    || /(^|\/)\.gitignore$/.test(file);
}

function changedFiles(base, head, cwd = process.cwd()) {
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
    throw new Error("Expected full base and head commit SHAs");
  }
  // Three-dot excludes changes merely merged from main. Disabling rename
  // detection retains both paths when an image input moves outside its scope.
  return execFileSync("git", [
    "diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--",
  ], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0").filter(Boolean);
}

module.exports = { isImageInput, changedFiles };

if (require.main === module) {
  const changed = changedFiles(process.argv[2], process.argv[3]);
  console.log(`build=${changed.some(isImageInput)}`);
}
