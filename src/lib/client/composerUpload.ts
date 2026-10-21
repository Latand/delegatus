import { getLocale, translate } from "@/lib/i18n";
import { isComposerUploadRef, type ComposerUploadRef } from "@/lib/filePolicy";

/** XHR exposes upload progress on desktop and mobile Safari. The File goes
 * straight to the network, without a base64 or JSON copy. */
export function uploadComposerFile(file: File, signal: AbortSignal, progress: (percent: number) => void): Promise<ComposerUploadRef> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: Error, upload?: ComposerUploadRef) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(upload!);
    };
    const abort = () => { request.abort(); finish(new Error(translate(getLocale(), "attach.uploadInterrupted"))); };
    request.open("POST", "/api/composer-upload");
    request.timeout = 15 * 60 * 1000;
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0 && !settled) progress(Math.min(99, Math.floor(event.loaded / event.total * 100)));
    };
    request.onload = () => {
      try {
        const answer = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300 && isComposerUploadRef(answer.upload) && answer.upload.bytes === file.size) finish(undefined, answer.upload);
        else finish(new Error(typeof answer.error === "string" ? answer.error : translate(getLocale(), "attach.uploadFailed")));
      } catch { finish(new Error(translate(getLocale(), "attach.uploadUnverified"))); }
    };
    request.onerror = () => finish(new Error(translate(getLocale(), "attach.uploadFailed")));
    request.ontimeout = () => { finish(new Error(translate(getLocale(), "attach.uploadTimedOut"))); request.abort(); };
    request.onabort = () => finish(new Error(translate(getLocale(), "attach.uploadInterrupted")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      progress(0);
      try { request.send(file); } catch { finish(new Error(translate(getLocale(), "attach.uploadFailed"))); }
    }
  });
}
