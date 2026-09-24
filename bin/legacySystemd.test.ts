import { expect, test } from "bun:test";

import { DOCKER_INSTALL_GUIDE, findLegacySystemdUnits, legacySystemdNotice } from "./legacySystemd.mjs";

const HOME = "/fixture-home";
const UNIT_DIR = `${HOME}/.config/systemd/user`;
const VIEWER_UNIT = `${UNIT_DIR}/agent-log-viewer.service`;
const TMUX_UNIT = `${UNIT_DIR}/agent-log-viewer-legacy-tmux.service`;

function presentOnly(...paths: string[]) {
  const set = new Set(paths);
  return (filename: string) => set.has(filename);
}

test("finds the retired units in the user unit directory, following XDG_CONFIG_HOME", () => {
  expect(findLegacySystemdUnits({ platform: "linux", env: {}, home: HOME, present: presentOnly(VIEWER_UNIT, TMUX_UNIT) }))
    .toEqual([
      { name: "agent-log-viewer.service", path: VIEWER_UNIT },
      { name: "agent-log-viewer-legacy-tmux.service", path: TMUX_UNIT },
    ]);
  const xdgUnit = "/fixture-config/systemd/user/agent-log-viewer.service";
  expect(findLegacySystemdUnits({ platform: "linux", env: { XDG_CONFIG_HOME: "/fixture-config" }, home: HOME, present: presentOnly(xdgUnit, VIEWER_UNIT) }))
    .toEqual([{ name: "agent-log-viewer.service", path: xdgUnit }]);
});

test("a renamed unit, a machine without one and a non-Linux platform find nothing", () => {
  const renamed = `${VIEWER_UNIT}.retired-20260725`;
  expect(findLegacySystemdUnits({ platform: "linux", env: {}, home: HOME, present: presentOnly(renamed) })).toEqual([]);
  expect(findLegacySystemdUnits({ platform: "linux", env: {}, home: HOME, present: () => false })).toEqual([]);
  expect(findLegacySystemdUnits({ platform: "darwin", env: {}, home: HOME, present: () => true })).toEqual([]);
});

test("no unit, no notice", () => {
  expect(legacySystemdNotice([])).toBeNull();
  expect(legacySystemdNotice([], "uk")).toBeNull();
});

test("the notice names every unit found, the commands that stop and remove them, and the Docker guide", () => {
  const notice = legacySystemdNotice([{ name: "agent-log-viewer.service", path: VIEWER_UNIT }])!;
  expect(notice).toBe([
    "The systemd install of Delegatus is retired: Docker is the only install.",
    `This machine still has the legacy units: ${VIEWER_UNIT}`,
    "Stop and remove them:",
    "  systemctl --user disable --now agent-log-viewer.service",
    `  rm ${VIEWER_UNIT}`,
    "  systemctl --user daemon-reload",
    `Then install Delegatus with Docker: ${DOCKER_INSTALL_GUIDE}`,
  ].join("\n"));
});

test("the tmux supervisor unit carries a warning that stopping it ends its sessions, in both languages", () => {
  const units = [
    { name: "agent-log-viewer.service", path: VIEWER_UNIT },
    { name: "agent-log-viewer-legacy-tmux.service", path: TMUX_UNIT },
  ];
  const en = legacySystemdNotice(units)!;
  expect(en).toContain("systemctl --user disable --now agent-log-viewer.service agent-log-viewer-legacy-tmux.service");
  expect(en).toContain(`rm ${VIEWER_UNIT} ${TMUX_UNIT}`);
  expect(en).toContain("ends every tmux session it hosts");
  const uk = legacySystemdNotice(units, "uk")!;
  expect(uk).toContain("єдиний спосіб встановлення — Docker");
  expect(uk).toContain("закриває всі tmux-сесії");
  expect(uk).toContain("systemctl --user disable --now agent-log-viewer.service agent-log-viewer-legacy-tmux.service");
  expect(uk).toContain(DOCKER_INSTALL_GUIDE);
});
