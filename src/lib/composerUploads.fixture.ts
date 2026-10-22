import { ComposerUploadError, receiveComposerUpload, resolveComposerUpload } from "./composerUploads";

try {
  if (process.argv[2] === "resolve") {
    const stored = await resolveComposerUpload(JSON.parse(process.argv[3]!), "operator");
    process.stdout.write(JSON.stringify({ bytes: stored.bytes }));
  } else {
    await receiveComposerUpload(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1])); controller.close();
    } }), "operator");
    process.stdout.write(JSON.stringify({ status: 200 }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ status: error instanceof ComposerUploadError ? error.status : 500 }));
}
