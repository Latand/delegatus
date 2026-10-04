import { prepareTranscriptSearchIndexInBackground } from "./search/transcriptSearch";

// Webpack worker entries execute without Bun's import.meta.main marker.
prepareTranscriptSearchIndexInBackground();
