import { parentPort, workerData } from "node:worker_threads";
import { evidenceHtmlImageSources, transformEvidenceHtml, type EvidenceHtmlWorkerRequest } from "./evidenceHtml";

if (parentPort) {
  const request = workerData as EvidenceHtmlWorkerRequest;
  const result = request.operation === "images"
    ? evidenceHtmlImageSources(request.source)
    : transformEvidenceHtml(request.source, request.baseHref, request.inlineImages ? new Map(request.inlineImages) : undefined);
  parentPort.postMessage(result);
}
