import { defineConfig, globalIgnores } from "eslint/config";
import { fixupConfigRules } from "@eslint/compat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  // Next's React plugin still uses rule-context APIs removed by ESLint 10.
  // Adapt those APIs while retaining every configured rule.
  ...fixupConfigRules([...nextVitals, ...nextTs]),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Publish artifact assembled by scripts/prepack.mjs; gitignored.
    "dist/**",
    // Agent worktrees created by Claude Code sessions; each lints itself.
    ".claude/**",
    // Research artifacts dropped by tmux-multi-agent sessions; third-party code.
    ".tmux-multi-agent/**",
  ]),
  {
    files: ["src/lib/**", "src/app/api/**", "src/runtime-host/**"],
    ignores: ["**/*.test.*", "**/*.fixture.*", "**/fixtures/**", "**/*.worker.ts",
      "**/*Child.ts", "src/lib/pipelines/worktreeSweep.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "@/lib/pipelines/store",
        importNames: ["loadArchivedPipelines"],
        message: "Use loadArchivedPipelinesForList for frozen projection reads; mutable archive copies belong to archive maintenance." }] }],
      // Dynamic store imports and namespace calls need the same restriction.
      "no-restricted-syntax": ["error",
        { selector: "ImportSpecifier[imported.name='loadArchivedPipelines'], ImportSpecifier[imported.value='loadArchivedPipelines']",
          message: "Use loadArchivedPipelinesForList for archive projections, including relative imports." },
        { selector: "VariableDeclarator > ObjectPattern > Property[key.name='loadArchivedPipelines'], VariableDeclarator > ObjectPattern > Property[key.value='loadArchivedPipelines']",
          message: "Use loadArchivedPipelinesForList for archive projections." },
        { selector: "MemberExpression[property.name='loadArchivedPipelines'], MemberExpression[computed=true][property.value='loadArchivedPipelines']",
          message: "Use loadArchivedPipelinesForList for archive projections." }],
    },
  },
  {
    // `.cjs` names CommonJS, and these files mean it: they are mounted into the
    // pinned puppeteer image and run by plain `node`, where `puppeteer` and
    // `sharp` resolve through NODE_PATH — which Node honours for `require` and
    // not for ESM `import`. Rewriting them as modules would break resolution in
    // the container, so `require()` is the correct module style here rather than
    // a lapse, and the rule that forbids it does not apply.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
