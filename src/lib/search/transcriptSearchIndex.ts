import { prepareTranscriptSearchIndexInBackground } from "./transcriptSearch";

/** Build large read indexes away from the Viewer request thread. */
if (import.meta.main) {
  prepareTranscriptSearchIndexInBackground();
}
