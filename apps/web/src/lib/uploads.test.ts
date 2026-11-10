import { FILE_TOO_LARGE, MAX_FILE_SIZE, uploadPartPath, uploadPreviewPath, uploadsPath, type Message } from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewOf } from "./previews";
import { CONNECTION_LOST, UPLOAD_FAILED, UploadError, uploadFile } from "./uploads";

// jsdom makes no previews (previews.test.ts tests making them), so files have none unless a test gives one.
vi.mock("./previews", () => ({ previewOf: vi.fn(async () => null) }));

/** Stands in for the browser's XMLHttpRequest, which tests answer as the Worker would. */
class FakeRequest {
  static all: FakeRequest[] = [];

  method = "";
  url = "";
  body: Blob | null = null;
  status = 0;
  responseText = "";
  readonly upload = new EventTarget();
  private readonly events = new EventTarget();

  constructor() {
    FakeRequest.all.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  addEventListener(type: string, listener: EventListener) {
    this.events.addEventListener(type, listener);
  }

  send(body: Blob) {
    this.body = body;
  }

  /** Reports `loaded` of the part's bytes sent. */
  sent(loaded: number) {
    this.upload.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded, total: this.body!.size }));
  }

  answer(status: number, text = "") {
    this.status = status;
    this.responseText = text;
    this.events.dispatchEvent(new Event("load"));
  }

  drop() {
    this.events.dispatchEvent(new Event("error"));
  }
}

/** The `n`th part's request, once it's been sent. */
async function part(n: number): Promise<FakeRequest> {
  await vi.waitFor(() => expect(FakeRequest.all.length).toBeGreaterThanOrEqual(n));
  return FakeRequest.all[n - 1]!;
}

const started = (parts: number, partSize = 10) => Response.json({ id: "k1", partSize, parts }, { status: 201 });
const message = { id: "m1", clientMessageId: "c1", plainText: "notes.txt" } as Message;

beforeEach(() => {
  FakeRequest.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
});

afterEach(() => vi.unstubAllGlobals());

describe("Attach files", () => {
  it("starts the upload with the file's name, type and size and its message's id, then sends its parts one after another", async () => {
    const fetch = vi.fn(async () => started(3));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["abcdefghij", "klmnopqrst", "uvwxy"], "notes.txt", { type: "text/plain" });
    const uploading = uploadFile("r1", file, "c1", () => {});

    expect(fetch).toHaveBeenCalledExactlyOnceWith(uploadsPath("r1"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", type: "text/plain", size: 25, clientMessageId: "c1" }),
    });
    for (const [n, text] of ["abcdefghij", "klmnopqrst"].entries()) {
      const request = await part(n + 1);
      expect([request.method, request.url, await request.body!.text()]).toEqual(["PUT", uploadPartPath("r1", "k1", n + 1), text]);
      // The next part waits for this one's answer.
      expect(FakeRequest.all).toHaveLength(n + 1);
      request.answer(204);
    }
    const last = await part(3);
    expect(await last.body!.text()).toBe("uvwxy");
    last.answer(201, JSON.stringify(message));
    expect(await uploading).toEqual(message);
  });

  it("answers the message a part sent again answers with", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => started(1)));
    const uploading = uploadFile("r1", new File(["hi"], "notes.txt"), "c1", () => {});
    (await part(1)).answer(200, JSON.stringify(message));
    expect(await uploading).toEqual(message);
  });
});

describe("Threads", () => {
  it("starts a reply's upload with its thread, and whether it goes to the room too", async () => {
    const fetch = vi.fn(async () => started(1));
    vi.stubGlobal("fetch", fetch);
    const uploading = uploadFile("r1", new File(["hi"], "notes.txt", { type: "text/plain" }), "c1", () => {}, { parentId: "m0", alsoSend: true });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(uploadsPath("r1"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", type: "text/plain", size: 2, clientMessageId: "c1", parentId: "m0", alsoSend: true }),
    });
    (await part(1)).answer(201, JSON.stringify(message));
    expect(await uploading).toEqual(message);
  });

  it("fails as the room says for a reply whose thread is gone, as it starts or as its last part goes", async () => {
    const gone = JSON.stringify({ error: "That message no longer exists" });
    const failure = (upload: Promise<Message>) => upload.then(() => null, (error: unknown) => (error instanceof UploadError ? error.message : error));
    const reply = () => uploadFile("r1", new File(["hi"], "notes.txt"), "c1", () => {}, { parentId: "m0", alsoSend: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(gone, { status: 422 })));
    expect(await failure(reply())).toBe("That message no longer exists");

    vi.stubGlobal("fetch", vi.fn(async () => started(1)));
    const uploading = failure(reply());
    (await part(1)).answer(422, gone);
    expect(await uploading).toBe("That message no longer exists");

    // A 422 that doesn't say why fails as any other answer does.
    FakeRequest.all = [];
    const unsaid = failure(reply());
    (await part(1)).answer(422, "<!DOCTYPE html>");
    expect(await unsaid).toBe(UPLOAD_FAILED);
  });
});

describe("Image, video and file previews", () => {
  it("sends the preview the browser makes of a file just before its last part, once the Worker has it", async () => {
    const thumbnail = new Blob(["thumbnail"], { type: "image/webp" });
    vi.mocked(previewOf).mockResolvedValueOnce(thumbnail);
    let answerPreview!: (response: Response) => void;
    const fetch = vi.fn(async (_path: string, init: RequestInit) => (init.method === "POST" ? started(2) : new Promise<Response>((resolve) => (answerPreview = resolve))));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["abcdefghij", "klmno"], "moon.png", { type: "image/png" });
    const uploading = uploadFile("r1", file, "c1", () => {});

    (await part(1)).answer(204);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(previewOf).toHaveBeenCalledWith(file);
    expect(fetch).toHaveBeenLastCalledWith(uploadPreviewPath("r1", "k1"), { method: "PUT", body: thumbnail });
    // The last part waits for the preview's answer.
    await new Promise((resolve) => setTimeout(resolve));
    expect(FakeRequest.all).toHaveLength(1);
    answerPreview(new Response(null, { status: 204 }));
    const last = await part(2);
    expect(await last.body!.text()).toBe("klmno");
    last.answer(201, JSON.stringify(message));
    expect(await uploading).toEqual(message);
  });

  it("sends a file without a preview where the browser makes none, and when the Worker refuses it or the connection drops", async () => {
    const refused = async () => new Response(null, { status: 415 });
    const dropped = async () => Promise.reject(new TypeError("Failed to fetch"));
    for (const answer of [null, refused, dropped]) {
      FakeRequest.all = [];
      if (answer) vi.mocked(previewOf).mockResolvedValueOnce(new Blob(["thumbnail"], { type: "image/webp" }));
      const fetch = vi.fn(async (_path: string, init: RequestInit) => (init.method === "POST" ? started(1) : answer!()));
      vi.stubGlobal("fetch", fetch);
      const uploading = uploadFile("r1", new File(["hi"], "moon.png", { type: "image/png" }), "c1", () => {});
      (await part(1)).answer(201, JSON.stringify(message));
      expect(await uploading).toEqual(message);
      expect(fetch).toHaveBeenCalledTimes(answer ? 2 : 1);
    }
  });
});

describe("Upload progress", () => {
  it("says how much of the file has gone, as a percentage rounded down, each time that changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => started(2, 100)));
    const progress: number[] = [];
    const uploading = uploadFile("r1", new File([new Uint8Array(300)], "moon.jpg"), "c1", (percent) => progress.push(percent));
    const first = await part(1);
    for (const loaded of [1, 2, 3, 50, 100]) first.sent(loaded);
    first.answer(204);
    const second = await part(2);
    second.sent(100);
    second.sent(199);
    second.answer(201, JSON.stringify(message));
    await uploading;
    expect(progress).toEqual([1, 16, 33, 66, 99, 100]);
  });

  it("fails as too large for a 413, connection lost when it drops, and failed for any other answer", async () => {
    const failure = (upload: Promise<Message>) =>
      upload.then(
        () => null,
        (error: unknown) => (error instanceof UploadError ? error.message : error),
      );
    const file = () => new File(["hi"], "notes.txt");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 413 })));
    expect(await failure(uploadFile("r1", file(), "c1", () => {}))).toBe(FILE_TOO_LARGE);
    // As from a room that's been deleted, or left.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Room not found or inaccessible" }, { status: 404 })));
    expect(await failure(uploadFile("r1", file(), "c1", () => {}))).toBe(UPLOAD_FAILED);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await failure(uploadFile("r1", file(), "c1", () => {}))).toBe(CONNECTION_LOST);

    vi.stubGlobal("fetch", vi.fn(async () => started(1)));
    for (const [answer, expected] of [
      [(request: FakeRequest) => request.answer(413), FILE_TOO_LARGE],
      [(request: FakeRequest) => request.answer(500), UPLOAD_FAILED],
      [(request: FakeRequest) => request.drop(), CONNECTION_LOST],
      // A success that isn't the message, such as a sign-in page.
      [(request: FakeRequest) => request.answer(200, "<!DOCTYPE html><html></html>"), UPLOAD_FAILED],
      [(request: FakeRequest) => request.answer(201, "{}"), UPLOAD_FAILED],
    ] as const) {
      FakeRequest.all = [];
      const uploading = failure(uploadFile("r1", file(), "c1", () => {}));
      answer(await part(1));
      expect(await uploading).toBe(expected);
    }
  });

  it("refuses a file over 250 MB before sending any of it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const file = new File(["hi"], "huge.mov");
    Object.defineProperty(file, "size", { value: MAX_FILE_SIZE + 1 });
    await expect(uploadFile("r1", file, "c1", () => {})).rejects.toThrow(new UploadError(FILE_TOO_LARGE));
    expect(fetch).not.toHaveBeenCalled();
  });
});
