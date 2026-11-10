import { FILE_TOO_LARGE, MAX_FILE_SIZE, uploadPartPath, uploadPreviewPath, uploadsPath, type Message, type RoomId, type Upload } from "@ember/protocol";
import { previewOf } from "./previews";

// Uploading a file as a message of its own, as Campfire's FileUploader does, but in parts that R2 puts
// back together, since a Worker takes at most 100 MB a request: the app starts the upload, sends its
// parts one after another, and the room posts the file as a message once it has the last. A picture's
// thumbnail or a video's poster, which the browser makes meanwhile (previews.ts), goes just before the
// last part.

/** What a failed upload says, unless the file is too large. */
export const UPLOAD_FAILED = "Upload failed. Please attach the file and try again.";

/** What an upload says when the connection drops. */
export const CONNECTION_LOST = "Connection lost. Please attach the file and try again.";

/** Why the composer leaves out a file picked to send, before any of it goes. */
export const tooLargeToAttach = (name: string) => `${name} is too large. Choose a file that’s 250 MB or smaller.`;

/** Why an upload failed, as its card says it. */
export class UploadError extends Error {}

/**
 * Why an answer with `status` and `text` failed an upload: a 413, a 422 that says why, as one does when the
 * thread the file was to go in is gone, or any other.
 */
function refused(status: number, text = ""): UploadError {
  if (status === 413) return new UploadError(FILE_TOO_LARGE);
  return new UploadError((status === 422 && reasonIn(text)) || UPLOAD_FAILED);
}

/** What an answer's `{ error }` says, if it's that. */
function reasonIn(text: string): string | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

/** How much of `total` bytes `sent` is, as a percentage rounded down. */
const percentOf = (sent: number, total: number) => (total === 0 ? 100 : Math.min(100, Math.floor((sent / total) * 100)));

/** The message the part that finished an upload answers with, or an UploadError for anything else, such as a sign-in page. */
function messageIn(text: string): Message {
  try {
    const message = JSON.parse(text) as Message;
    if (typeof message?.id === "string") return message;
  } catch {
    // Not the message, then.
  }
  throw new UploadError(UPLOAD_FAILED);
}

/**
 * Sends `part` to `path` with an XMLHttpRequest, whose upload reports its progress, as fetch's can't,
 * telling `onSent` how many of its bytes have gone, and answers the response's status and text.
 */
function sendPart(path: string, part: Blob, onSent: (bytes: number) => void): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", path);
    request.upload.addEventListener("progress", (event) => event.lengthComputable && onSent(event.loaded));
    request.addEventListener("load", () => resolve({ status: request.status, text: request.responseText }));
    request.addEventListener("error", () => reject(new UploadError(CONNECTION_LOST)));
    request.send(part);
  });
}

/** Sends `preview` as upload `id`'s in `roomId`. One the Worker doesn't take is left out, and the file shows without it. */
async function sendPreview(roomId: RoomId, id: string, preview: Blob | null) {
  if (preview) await fetch(uploadPreviewPath(roomId, id), { method: "PUT", body: preview }).catch(() => {});
}

/** The thread a file goes in as a reply, which `alsoSend` sends to the room too. */
export interface UploadThread {
  parentId: string;
  alsoSend: boolean;
}

/**
 * Uploads `file` to `roomId` as the message `clientMessageId` names, or as a reply in `thread`, telling
 * `onProgress` how much of it has gone, as a percentage rounded down, each time that changes, and answers
 * the message the room posts it as. It fails with an UploadError saying why, as the file's card says it.
 */
export async function uploadFile(roomId: RoomId, file: File, clientMessageId: string, onProgress: (percent: number) => void, thread?: UploadThread): Promise<Message> {
  if (file.size > MAX_FILE_SIZE) throw new UploadError(FILE_TOO_LARGE);
  const started = await fetch(uploadsPath(roomId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, type: file.type, size: file.size, clientMessageId, ...thread }),
  }).catch(() => {
    throw new UploadError(CONNECTION_LOST);
  });
  if (started.status !== 201) throw refused(started.status, await started.text().catch(() => ""));
  const { id, partSize, parts } = (await started.json()) as Upload;
  const preview = previewOf(file);

  let shown = 0;
  const progress = (sent: number) => {
    const percent = percentOf(sent, file.size);
    if (percent !== shown) onProgress((shown = percent));
  };
  for (let n = 1; n < parts; n++) {
    const start = (n - 1) * partSize;
    const { status } = await sendPart(uploadPartPath(roomId, id, n), file.slice(start, start + partSize), (bytes) => progress(start + bytes));
    if (status !== 204) throw refused(status);
  }
  await sendPreview(roomId, id, await preview);
  const start = (parts - 1) * partSize;
  const { status, text } = await sendPart(uploadPartPath(roomId, id, parts), file.slice(start), (bytes) => progress(start + bytes));
  if (status !== 201 && status !== 200) throw refused(status, text);
  progress(file.size);
  return messageIn(text);
}
