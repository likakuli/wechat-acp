import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMonitor } from "../dist/src/weixin/monitor.js";

test("monitor does not save the poll cursor when message handling fails", async (t) => {
  const originalFetch = globalThis.fetch;
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wechat-acp-monitor-"));
  const controller = new AbortController();

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => jsonResponse({
    ret: 0,
    get_updates_buf: "next-cursor",
    msgs: [userMessage()],
  });

  await startMonitor({
    baseUrl: "https://ilink.test",
    token: "token",
    storageDir,
    abortSignal: controller.signal,
    longPollTimeoutMs: 1,
    log: () => {},
    onMessage: () => {
      controller.abort();
      throw new Error("enqueue failed");
    },
  });

  assert.equal(fs.existsSync(path.join(storageDir, "sync-buf.json")), false);
});

test("monitor saves the poll cursor after messages are accepted", async (t) => {
  const originalFetch = globalThis.fetch;
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wechat-acp-monitor-"));
  const controller = new AbortController();

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => jsonResponse({
    ret: 0,
    get_updates_buf: "next-cursor",
    msgs: [userMessage()],
  });

  await startMonitor({
    baseUrl: "https://ilink.test",
    token: "token",
    storageDir,
    abortSignal: controller.signal,
    longPollTimeoutMs: 1,
    log: () => {},
    onMessage: () => {
      controller.abort();
    },
  });

  const saved = JSON.parse(fs.readFileSync(path.join(storageDir, "sync-buf.json"), "utf-8"));
  assert.equal(saved.get_updates_buf, "next-cursor");
});

function userMessage() {
  return {
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
