import { createElement, type ComponentType, type ReactNode } from "react";

import type { ComposerBarProps } from "@/components/ComposerBar";
import type { RoleCatalogItem } from "@/components/DraftAgentPane";
import type { SpawnAttempt } from "@/components/draftSpawn";

import type { AgentLaunchDraft } from "./AgentLaunchControls";

/**
 * The seam between what a new-agent draft IS and how it is drawn
 * (docs/design/new-agent-redesign.md). `DraftAgentPane` owns the state, the
 * launch and its recovery; a layout only arranges the parts below. Nothing
 * registers a layout in the product: the pane draws its own arrangement unless
 * a design prototype installs another one for the page it runs in.
 */
export interface DraftLayoutParts {
  draftId: string;
  /** Engine, model, effort, speed and account, with their invariants. */
  launch: AgentLaunchDraft;
  /** Every field is locked while a launch is in flight. */
  fieldsDisabled: boolean;
  /** «New conversation», or the conversation a handoff draft continues. */
  heading: string;
  headingTitle?: string;
  /** The transcript a handoff draft continues; empty for a plain draft. */
  src: string;
  /** The board card the draft was opened from (`task:<id>`), or empty. */
  band: string;
  cwd: string;
  dirs: string[];
  setCwd: (value: string) => void;
  roles: RoleCatalogItem[];
  roleId: string;
  roleParams: Record<string, string | number>;
  selectRole: (roleId: string) => void;
  setRoleParam: (key: string, value: string | number) => void;
  /** The reviewer's conversation and the deployer's confirmation, when the role asks. */
  roleExtras: ReactNode;
  /** The launch in flight, or null while the draft is still being written. */
  attempt: SpawnAttempt | null;
  /** The product's own status line for that launch: booting, confirming, needs attention. */
  launchStatus: ReactNode;
  /** The image capability could not be read; carries its own Retry. */
  capabilityAlert: ReactNode;
  /** The shared composer's props: prompt, attachments, voice, launch, errors. */
  composerProps: ComposerBarProps;
  submit: () => void;
  onClose: () => void;
}

export type DraftLayout = ComponentType<DraftLayoutParts>;

let installed: DraftLayout | null = null;

/** Design prototypes only: draw every draft on this page through `layout`. */
export function installDraftLayout(layout: DraftLayout | null): void {
  installed = layout;
}

export function hasDraftLayout(): boolean {
  return installed !== null;
}

/** The installed layout, drawn through one stable component so its hooks keep their place. */
export function InstalledDraftLayout(parts: DraftLayoutParts) {
  return installed ? createElement(installed, parts) : null;
}
