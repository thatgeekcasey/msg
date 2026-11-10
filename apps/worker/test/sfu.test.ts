import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { acceptAnswer, closeTracks, publishTracks, pullTracks, SfuError, startSession, TRACKS_PER_REQUEST } from "../src/huddles/sfu";
import { APP } from "./huddle-support";

// What the Worker makes of the Realtime SFU's answers, each of which a test gives it here. The room's
// huddle tests (huddle-room.test.ts) have a stand-in answer as the SFU does when all goes well.

const bindings = env as unknown as Env;
const SESSION = "e017a2629c754fedc1f7d8587e06d126";
const PUBLISHER = "5b6d5c7a8e9f4a1b2c3d4e5f60718293";

/** A request the SFU was sent. */
interface Sent {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** Has the SFU answer each request with the next of `answers`, and keeps what it's sent. */
function sfuAnswers(...answers: Array<() => Response | Promise<Response>>): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    sent.push({ url: request.url, method: request.method, authorization: request.headers.get("Authorization"), body: text === "" ? null : (JSON.parse(text) as unknown) });
    const answer = answers.shift();
    if (!answer) throw new Error(`The SFU was asked more than the test answers: ${request.method} ${request.url}`);
    return answer();
  });
  return sent;
}

const said = (body: unknown, status = 200) => () => Response.json(body, { status });
const address = (path: string) => `https://rtc.live.cloudflare.com/v1/apps/${APP.appId}${path}`;

/** What `asked` came to: the `SfuError` it threw, by its status and code. */
async function refusal(asked: Promise<unknown>): Promise<{ status: number | null; code: string | null }> {
  const error = await asked.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(SfuError);
  const { status, code } = error as SfuError;
  return { status, code };
}

afterEach(() => vi.restoreAllMocks());

describe("The Realtime SFU, as the Worker asks it", () => {
  it("starts a session as the app, with the app's secret as its bearer token", async () => {
    const sent = sfuAnswers(said({ sessionId: SESSION }, 201));
    expect(await startSession(bindings, APP)).toBe(SESSION);
    expect(sent).toEqual([{ url: address("/sessions/new"), method: "POST", authorization: `Bearer ${APP.appSecret}`, body: null }]);
  });

  it("takes no session whose ID couldn't go in an address", async () => {
    for (const sessionId of ["../../other-app/sessions/x", "", "a".repeat(129), 7, null]) {
      sfuAnswers(said({ sessionId }, 201));
      expect(await refusal(startSession(bindings, APP)), String(sessionId)).toEqual({ status: 200, code: null });
      vi.mocked(fetch).mockRestore();
    }
  });

  it("says how the SFU refused, by its status and error code, and no more", async () => {
    const refusals: Array<[() => Response | Promise<Response>, { status: number | null; code: string | null }]> = [
      [said({ errorCode: "unauthorized", errorDescription: `The secret ${APP.appSecret} was not accepted` }, 401), { status: 401, code: "unauthorized" }],
      [() => new Response("Bad gateway", { status: 502 }), { status: 502, code: null }],
      // An answer can be a refusal whatever its status.
      [said({ errorCode: "session_error", errorDescription: "Session is not ready" }), { status: 200, code: "session_error" }],
      [said({ errorCode: "x".repeat(100) }, 400), { status: 400, code: "x".repeat(40) }],
      [said([]), { status: 200, code: null }],
      [() => new Response(null, { status: 302, headers: { Location: "https://example.com/" } }), { status: 302, code: null }],
      [() => Promise.reject(new TypeError("Network connection lost")), { status: null, code: null }],
    ];
    for (const [answer, expected] of refusals) {
      sfuAnswers(answer);
      const error = await acceptAnswer(bindings, APP, SESSION, "an answer").catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SfuError);
      expect({ status: (error as SfuError).status, code: (error as SfuError).code }).toEqual(expected);
      expect((error as SfuError).message).not.toContain(APP.appSecret);
      vi.mocked(fetch).mockRestore();
    }
  });

  it("publishes tracks with a browser's offer, answering the SFU's answer once it has taken every one", async () => {
    const tracks = [
      { mid: "0", trackName: "audio" },
      { mid: "1", trackName: "video" },
    ];
    const sent = sfuAnswers(said({ requiresImmediateRenegotiation: false, sessionDescription: { type: "answer", sdp: "the SFU's answer" }, tracks }));
    expect(await publishTracks(bindings, APP, SESSION, "a browser's offer", tracks)).toBe("the SFU's answer");
    expect(sent).toEqual([
      {
        url: address(`/sessions/${SESSION}/tracks/new`),
        method: "POST",
        authorization: `Bearer ${APP.appSecret}`,
        body: {
          sessionDescription: { type: "offer", sdp: "a browser's offer" },
          tracks: [
            { location: "local", mid: "0", trackName: "audio" },
            { location: "local", mid: "1", trackName: "video" },
          ],
        },
      },
    ]);

    const untaken: Array<[unknown, string | null]> = [
      [{ sessionDescription: { type: "answer", sdp: "an answer" }, tracks: [tracks[0], { ...tracks[1], errorCode: "internal_error" }] }, "internal_error"],
      [{ sessionDescription: { type: "answer", sdp: "an answer" }, tracks: [tracks[0]] }, null],
      [{ sessionDescription: { type: "offer", sdp: "an offer" }, tracks }, null],
      [{ tracks }, null],
    ];
    for (const [answer, code] of untaken) {
      vi.mocked(fetch).mockRestore();
      sfuAnswers(said(answer));
      expect(await refusal(publishTracks(bindings, APP, SESSION, "a browser's offer", tracks)), JSON.stringify(answer)).toEqual({ status: 200, code });
    }
  });

  it("pulls tracks into a session, telling those the SFU offers from those it couldn't find", async () => {
    const wanted = [
      { sessionId: PUBLISHER, trackName: "audio" },
      { sessionId: PUBLISHER, trackName: "video" },
      { sessionId: SESSION, trackName: "audio" },
    ];
    const sent = sfuAnswers(
      said({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "the SFU's offer" },
        tracks: [
          { sessionId: PUBLISHER, trackName: "audio", mid: "4" },
          { sessionId: PUBLISHER, trackName: "video", errorCode: "not_found_track_error", errorDescription: "Track not found" },
        ],
      }),
    );
    expect(await pullTracks(bindings, APP, SESSION, wanted)).toEqual({
      offer: "the SFU's offer",
      tracks: [{ sessionId: PUBLISHER, trackName: "audio", mid: "4" }],
      missing: [
        { sessionId: PUBLISHER, trackName: "video", code: "not_found_track_error" },
        // One it says nothing of isn't one it offers.
        { sessionId: SESSION, trackName: "audio", code: "missing" },
      ],
    });
    expect(sent[0]).toMatchObject({ url: address(`/sessions/${SESSION}/tracks/new`), method: "POST", body: { tracks: wanted.map((track) => ({ location: "remote", ...track })) } });

    // With none found, it offers nothing.
    vi.mocked(fetch).mockRestore();
    sfuAnswers(said({ requiresImmediateRenegotiation: false, tracks: [{ sessionId: PUBLISHER, trackName: "audio", errorCode: "empty_track_error" }] }));
    expect(await pullTracks(bindings, APP, SESSION, wanted.slice(0, 1))).toEqual({ offer: null, tracks: [], missing: [{ sessionId: PUBLISHER, trackName: "audio", code: "empty_track_error" }] });
    // A track with no offer to carry it isn't one a browser can be sent.
    vi.mocked(fetch).mockRestore();
    sfuAnswers(said({ tracks: [{ sessionId: PUBLISHER, trackName: "audio", mid: "0" }] }));
    expect(await refusal(pullTracks(bindings, APP, SESSION, wanted.slice(0, 1)))).toEqual({ status: 200, code: null });
  });

  it("gives the SFU a browser's answer to its offer", async () => {
    const sent = sfuAnswers(said({}));
    await acceptAnswer(bindings, APP, SESSION, "a browser's answer");
    expect(sent).toEqual([
      { url: address(`/sessions/${SESSION}/renegotiate`), method: "PUT", authorization: `Bearer ${APP.appSecret}`, body: { sessionDescription: { type: "answer", sdp: "a browser's answer" } } },
    ]);
  });

  it("closes tracks without their browser's say, answering the ones the SFU didn't close", async () => {
    const sent = sfuAnswers(
      said({
        requiresImmediateRenegotiation: false,
        tracks: [{ mid: "0" }, { mid: "1", errorCode: "close_track_error", errorDescription: "Track doesn't exist or was already closed" }, { mid: "2", errorCode: "internal_error", errorDescription: "Backend error" }],
      }),
    );
    // One that was closed already is closed, and one the SFU says nothing of isn't.
    expect(await closeTracks(bindings, APP, SESSION, ["0", "1", "2", "3"])).toEqual(["2", "3"]);
    expect(sent).toEqual([
      {
        url: address(`/sessions/${SESSION}/tracks/close`),
        method: "PUT",
        authorization: `Bearer ${APP.appSecret}`,
        body: { tracks: [{ mid: "0" }, { mid: "1" }, { mid: "2" }, { mid: "3" }], force: true },
      },
    ]);
  });

  it("closes as many tracks as the SFU takes in a request at a time, leaving open those of a request it refused", async () => {
    const mids = Array.from({ length: 2 * TRACKS_PER_REQUEST + 5 }, (_, n) => String(n));
    const closing = (request: string[]) => said({ tracks: request.map((mid) => ({ mid })) });
    const sent = sfuAnswers(closing(mids.slice(0, TRACKS_PER_REQUEST)), said({ errorCode: "temporarily_unavailable_error" }, 503), closing(mids.slice(2 * TRACKS_PER_REQUEST)));
    expect(await closeTracks(bindings, APP, SESSION, mids)).toEqual(mids.slice(TRACKS_PER_REQUEST, 2 * TRACKS_PER_REQUEST));
    expect(sent.map(({ body }) => (body as { tracks: unknown[] }).tracks.length)).toEqual([TRACKS_PER_REQUEST, TRACKS_PER_REQUEST, 5]);
    expect(await closeTracks(bindings, APP, SESSION, [])).toEqual([]);
  });
});
