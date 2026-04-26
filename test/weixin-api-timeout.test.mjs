import test from "node:test";
import assert from "node:assert/strict";
import { sendTextMessage } from "../dist/src/weixin/send.js";

test("sendTextMessage rejects when the iLink request times out", async (t) => {
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    const err = new Error("request timed out");
    err.name = "AbortError";
    throw err;
  };

  await assert.rejects(
    () => sendTextMessage("user-1", "hello", {
      baseUrl: "https://ilink.test",
      token: "token",
      contextToken: "ctx-1",
    }),
    /timed out|AbortError|aborted/i,
  );
});
