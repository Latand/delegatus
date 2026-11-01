import type { PublishPrototypeInput } from "@/lib/prototypeReview/types";
import type { AppConnectRow } from "./appConnectTypes";

export const APP_CONNECT_QUESTION = "github-app-connect";

/** The only builder of external action links in a decision form. */
export function appConnectForm(row: AppConnectRow, language: "en" | "uk"): PublishPrototypeInput {
  const uk = language === "uk";
  const d = row.discovery;
  const links: Array<{ label: string; href: string }> = [];
  const missing = d.missingPermissions;
  if (d.covered && missing.length) {
    if (d.missingAppPermissions.length) links.push({ href: d.context.settingsUrl,
      label: uk ? `1. Permissions & events: ${d.missingAppPermissions.map(key => `${key}: ${row.permissions[key]}`).join(", ")}; Save changes.`
        : `1. Permissions & events: set ${d.missingAppPermissions.map(key => `${key}: ${row.permissions[key]}`).join(", ")}; Save changes.` });
    if (d.installationUrl) links.push({ href: d.installationUrl,
      label: uk ? `${links.length + 1}. Прийміть оновлені дозволи для ${row.repository}: ${missing.join(", ")}.`
        : `${links.length + 1}. Accept the updated permissions for ${row.repository}: ${missing.join(", ")}.` });
  } else if (!d.covered) {
    if (d.installationUrl) {
      if (d.missingAppPermissions.length) links.push({ href: d.context.settingsUrl,
        label: `1. Permissions & events: ${d.missingAppPermissions.map(key => `${key}: ${row.permissions[key]}`).join(", ")}; Save changes.` });
      links.push({ href: d.installationUrl,
        label: (uk ? `Repository access: додайте ${row.repository}.` : `Repository access: add ${row.repository}.`) +
          (missing.length ? (uk ? ` Прийміть дозволи: ${missing.join(", ")}.` : ` Accept permissions: ${missing.join(", ")}.`) : "") });
    }
    else {
      if (d.context.prerequisite === "app_private") links.push({ href: d.context.settingsUrl,
        label: uk ? "1. Advanced → Make public. App зможе встановити будь-хто; повернути приватність можна після видалення з інших акаунтів. Бачите Make private? Крок уже зроблено."
          : "1. Advanced → Make public. Anyone can install it; making it private again requires removal from other accounts. Seeing Make private means this is done." });
      if (d.missingAppPermissions.length) {
        const instruction = `Permissions & events: ${d.missingAppPermissions.map(key => `${key}: ${row.permissions[key]}`).join(", ")}; Save changes.`;
        if (links.length) links[0]!.label += ` ${instruction}`;
        else links.push({ href: d.context.settingsUrl, label: `1. ${instruction}` });
      }
      const href = new URL(`https://github.com/apps/${d.context.slug}/installations/new${row.repositoryId ? "/permissions" : ""}`);
      if (row.repositoryId) {
        href.searchParams.set("suggested_target_id", String(d.context.accountId));
        href.searchParams.append("repository_ids[]", String(row.repositoryId));
      }
      links.push({ href: href.href, label: row.repositoryId
        ? (uk ? `${links.length + 1}. Встановіть App для ${row.repository}.` : `${links.length + 1}. Install the App for ${row.repository}.`)
        : (uk ? `Only select repositories → ${row.repository}.` : `Only select repositories → ${row.repository}.`) });
    }
  }
  const action = links.length
    ? (uk ? "Підтвердьте тут після кроків на GitHub. Delegatus перевірить результат." : "Confirm here after the GitHub steps. Delegatus will verify the result.")
    : (uk ? "Підтвердьте тут. Delegatus перевірить результат." : "Confirm here. Delegatus will verify the result.");
  const click = uk ? "Натисніть посилання та Install на GitHub; відповідати тут не треба." : "Follow the link and Install on GitHub; no answer here is needed.";
  return { clientRequestId: `forge-connect:${row.requestId}:${row.replacedForm ? "repository" : "initial"}`,
    title: uk ? "GitHub App для репозиторію" : "GitHub App for a repository",
    questions: [{ id: APP_CONNECT_QUESTION,
      text: `${row.repository}: ${d.covered && missing.length ? (uk ? "потрібні дозволи. " : "permissions needed. ") : ""}${!d.covered && row.ownRepository && !d.installationId ? click : action}`,
      options: [{ label: uk ? "Підключити" : "Connect", recommended: true }, { label: uk ? "Не підключати" : "Do not connect" }],
      ...(links.length ? { links } : {}) }] };
}
