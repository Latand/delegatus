#!/usr/bin/env bun
/*
 * Lays the phone voice prototype over an export of the repository, so the existing phone driver
 * (src/components/mobile/issue1671Evidence.browser.test.tsx) renders it. Nothing in the worktree is
 * edited: every patched file is written into the export from its pristine copy in the worktree.
 *
 *   bun docs/design/mobile-voice-floating/harness/apply.mjs <worktree> <export>
 */
import fs from "node:fs";
import path from "node:path";

const [worktree, target] = process.argv.slice(2).map((value) => path.resolve(value));
if (!worktree || !target || worktree === target) throw new Error("usage: apply.mjs <worktree> <export>");
const HERE = "docs/design/mobile-voice-floating";

const LONG_FEED = String.raw`
function mvfFeed(feed: string): string {
  if (!new URLSearchParams(location.search).has("mvf-long")) return feed;
  const asked = ["Where does the search fix stand?", "And the phone board review?", "What is waiting on me?"];
  const said = [
    "The search fix is through its verifier on the second attempt. The first attempt failed on a stale index, which the lane rebuilt by itself before it ran the check again. Nothing in it needs a decision from you.",
    "The phone board review is on its second round. The reviewer asked for the column pager to keep its place after a card moves, and the builder has that change in its worktree. I expect the round to close within the hour.",
    "Two things wait on you. The release note for the weekly build needs your wording, and the account that ran out of its window yesterday needs you to sign in again before its lanes can continue.",
  ];
  const rows = asked.flatMap((text, index) => [
    JSON.stringify({ type: "user", uuid: "mvf-user-" + index, promptSource: "sdk", timestamp: iso(400 - index * 60), message: { role: "user", content: text } }),
    JSON.stringify({ type: "assistant", timestamp: iso(380 - index * 60), message: { role: "assistant", content: [{ type: "text", text: said[index] }] } }),
  ]);
  return feed + rows.join("\n") + "\n";
}
`;

const patch = (file, edit) => {
  const pristine = fs.readFileSync(path.join(worktree, file), "utf8");
  const next = edit(pristine);
  if (next === pristine) throw new Error(`${file}: the patch changed nothing`);
  fs.writeFileSync(path.join(target, file), next);
};
const once = (text, find, replacement) => {
  if (text.split(find).length !== 2) throw new Error(`expected exactly one ${JSON.stringify(find.slice(0, 60))}`);
  return text.replace(find, () => replacement);
};

fs.mkdirSync(path.join(target, HERE), { recursive: true });
fs.copyFileSync(path.join(worktree, HERE, "PhoneVoiceHead.tsx"), path.join(target, HERE, "PhoneVoiceHead.tsx"));

/* The fixture page: the head beside the real Viewer, the way the shell mounts the desktop companion beside its screens. */
patch("src/components/mobile/issue1671Evidence.fixture.tsx", (text) => {
  const mounted = once(text, "? <ScrollHistoryFixture /> : <Viewer />);", "? <ScrollHistoryFixture /> : <><Viewer /><PhoneVoicePrototype /></>);");
  const imported = once(mounted, 'import { Viewer } from "@/components/Viewer";', 'import { Viewer } from "@/components/Viewer";\nimport { PhoneVoicePrototype } from "../../../docs/design/mobile-voice-floating/PhoneVoiceHead";');
  /* `?mvf-long`: the seat's conversation filled past the screen, so what the head and its words cover is measured over real rows. */
  const fed = once(imported, 'files[0]!.engine === "codex" ? SEAT_CODEX_FEED : SEAT_FEED)', 'files[0]!.engine === "codex" ? SEAT_CODEX_FEED : mvfFeed(SEAT_FEED))');
  return `${fed}\n${LONG_FEED}`;
});

/* The board menu: «Показати голос» above Settings while the head is hidden. */
patch("src/components/headerMenu/HeaderMenu.tsx", (text) => {
  const imported = once(text, 'import { openVoiceCompanionSettings } from "@/components/voiceCompanion/VoiceCompanionSetting";',
    'import { openVoiceCompanionSettings } from "@/components/voiceCompanion/VoiceCompanionSetting";\nimport { phoneVoiceCopy, phoneVoiceHidden, showPhoneVoice } from "../../../docs/design/mobile-voice-floating/PhoneVoiceHead";');
  const localized = once(imported, "function PhoneMenu({ title, project, nav, create = [], board, rules = [], onClose }: Parameters<typeof HeaderMenuSheet>[0]) {\n  const { t } = useLocale();",
    "function PhoneMenu({ title, project, nav, create = [], board, rules = [], onClose }: Parameters<typeof HeaderMenuSheet>[0]) {\n  const { t, locale } = useLocale();");
  return once(localized, '      row("settings", Settings, t("headerMenu.settings"), () => go("settings"),',
    '      ...(phoneVoiceHidden() ? [row("voice-show", AudioLines, phoneVoiceCopy(locale).show, () => { close(); showPhoneVoice(); })] : []),\n      row("settings", Settings, t("headerMenu.settings"), () => go("settings"),');
});

/* The driver: one more case in the existing file. */
patch("src/components/mobile/issue1671Evidence.browser.test.tsx", (text) => `${text}\n${fs.readFileSync(path.join(worktree, HERE, "harness/driver-case.txt"), "utf8")}`);
console.log("prototype applied to", target);
