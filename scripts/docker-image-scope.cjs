const { execFileSync } = require("node:child_process");

// Dockerfile COPY/install/build inputs. next build also checks TypeScript
// outside src/ and its imported JS/JSON. Tailwind scans src/ (globals.css).
// Keep external JS/JSON dependencies explicit: the test checks this list
// against the installed TypeScript program so new imports cannot drift.
const files = new Set([
  "Dockerfile", ".dockerignore", "Dockerfile.dockerignore", ".gitignore", "package.json", "bun.lock", "bunfig.toml",
  "tsconfig.json", ".github/workflows/docker-image.yml",
  "scripts/whisper_transcribe.py", "scripts/published-image-entrypoint.sh",
  "scripts/demo-capture-browser.cjs", "scripts/newcomer-install.mjs",
  "scripts/npm-package-smoke.mjs", "scripts/package-revision.mjs", "scripts/docker-image-scope.cjs",
  "scripts/docker-pr-build.sh",
  "scripts/fixtures/usage-metrics/recorded.json", "landing/site/demo/taskIcons.json",
  // Docker copies these root files; Next loads them with NODE_ENV=production.
  ".env", ".env.local", ".env.production", ".env.production.local",
  ".babelrc", ".babelrc.json", ".babelrc.js", ".babelrc.mjs", ".babelrc.cjs",
  "babel.config.js", "babel.config.json", "babel.config.mjs", "babel.config.cjs",
  ".browserslistrc", "browserslist",
  ".postcssrc.json", ".postcssrc.js",
]);
const directories = ["src/", "public/", "bin/", "patches/", "vendor/"];

function isImageInput(file) {
  return files.has(file)
    || directories.some(directory => file.startsWith(directory))
    || /^(next|postcss)\.config\./.test(file)
    || /\.(?:[cm]?ts|tsx)$/.test(file);
}

// Changes to installation, native tools or the image recipe need both Linux
// architectures. App sources use native amd64 verification; publication always
// builds both. Keep this conservative when adding platform-dependent inputs.
function isMultiArchInput(file) {
  return ["Dockerfile", ".dockerignore", "Dockerfile.dockerignore", "package.json", "bun.lock", "bunfig.toml",
    ".github/workflows/docker-image.yml", "scripts/docker-image-scope.cjs", "scripts/docker-pr-build.sh",
    "scripts/whisper_transcribe.py", "scripts/published-image-entrypoint.sh",
    "scripts/newcomer-install.mjs", "scripts/npm-package-smoke.mjs"].includes(file)
    || ["patches/", "vendor/", "bin/", "src/runtime-host/", "src/lib/platform/"].some(directory => file.startsWith(directory));
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

module.exports = { isImageInput, isMultiArchInput, changedFiles };

if (require.main === module) {
  const changed = changedFiles(process.argv[2], process.argv[3]);
  console.log(`build=${changed.some(isImageInput)}`);
  console.log(`platforms=${changed.some(isMultiArchInput) ? "linux/amd64,linux/arm64" : "linux/amd64"}`);
}
