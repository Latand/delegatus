import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveOrchestratorPanelState, parseSeatStatus } from "../orchestrator/seatState";
import { MobileOrchestratorSheet } from "./MobileOrchestratorSheet";

const failedAt = "2026-10-11T17:11:00.000Z";
test("the phone's failed designation banner renders the terminal time", () => {
  const status = parseSeatStatus({ lastFailure: { error: "database is locked", clientRequestId: "failed_designation", seatEpoch: 1,
    designatedAt: "2026-10-11T17:10:00.000Z", terminalizedAt: failedAt } });
  const state = deriveOrchestratorPanelState({ status, statusFailed: false, submitting: false, submitFailure: null, file: null, surface: null });
  const html = renderToStaticMarkup(<MobileOrchestratorSheet project="atlas" projectName="Atlas" sheet="rotate" now={Date.parse(failedAt) / 1000} state={state} status={status}
    file={null} incumbent={null} pendingMandate="" submitting={false}
    rotate={{ open: false, seat: null, vacated: false, opening: false, submitting: false, failure: null, onOpen() {}, onCancel() {}, onConfirm() {} }}
    tick={{ onOpen() {}, onClose() {} }} onConfirm={() => {}} onRecheck={() => {}} onOpenConversation={() => {}} onClose={() => {}} />);
  expect(html).toContain(`dateTime="${failedAt}"`);
  expect(html).toContain("data-orchestrator-failure-time");
  expect(html).not.toMatch(/AM|PM/);
});
