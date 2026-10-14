import type { TranscriptionLanguage } from "./languages";

export interface TranscribeResponse {
  text: string;
  language?: TranscriptionLanguage;
}

export interface UpstreamResult {
  status: number;
  body: string;
}
