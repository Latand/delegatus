import { parentPort, workerData } from "node:worker_threads";
import { evidenceHtmlImageSources, transformEvidenceHtml } from "./evidenceHtml";

const request = workerData as
  | { operation: "images"; source: string }
  | { operation: "transform"; source: string; baseHref?: string; inlineImages?: Array<[string, string]> };

const result = request.operation === "images"
  ? evidenceHtmlImageSources(request.source)
  : transformEvidenceHtml(request.source, request.baseHref, request.inlineImages ? new Map(request.inlineImages) : undefined);

parentPort?.postMessage(result);
