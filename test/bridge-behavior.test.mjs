import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WeChatAcpBridge } from "../dist/src/bridge.js";
import { defaultConfig } from "../dist/src/config.js";

test("overflow continuation remains pending when resend fails", async (t) => {
  const originalFetch = globalThis.fetch;
  const bridge = createBridge();
  bridge.pendingOverflowReplies.set("user-1", {
    textSegments: ["remaining text"],
    images: [],
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("ilink/bot/sendmessage")) {
      return jsonResponse({ ret: -2, errmsg: "rejected" });
    }
    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  await assert.rejects(
    () => bridge.continuePendingReply("user-1", "ctx-1"),
    /ret=-2/,
  );
  assert.ok(bridge.pendingOverflowReplies.has("user-1"));
});

test("image reply send failures reject the reply", async (t) => {
  const originalFetch = globalThis.fetch;
  const bridge = createBridge();

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("ilink/bot/getuploadurl")) {
      return jsonResponse({ ret: 0, upload_full_url: "https://cdn.test/upload" });
    }
    if (requestUrl.includes("cdn.test/upload")) {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      });
    }
    if (requestUrl.includes("ilink/bot/sendmessage")) {
      return jsonResponse({ ret: -2, errmsg: "image rejected" });
    }
    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  await assert.rejects(
    () => bridge.sendReplyParts("user-1", "ctx-1", [], [{
      data: Buffer.from("image").toString("base64"),
      mimeType: "image/png",
      name: "image.png",
    }]),
    /ret=-2/,
  );
});

test("nearby user messages are batched into one ACP prompt", async () => {
  const config = defaultConfig();
  config.session.messageBatchDelayMs = 500;
  config.session.textMessageBatchDelayMs = 20;
  const bridge = new WeChatAcpBridge(config, () => {});
  const enqueued = [];
  bridge.sessionManager = {
    enqueue: async (userId, message) => {
      enqueued.push({ userId, message });
    },
  };

  await bridge.handleMessage(textMessage("first", "ctx-1"));
  await bridge.handleMessage(textMessage("second", "ctx-2"));

  assert.equal(enqueued.length, 0);
  await sleep(60);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].userId, "user-1");
  assert.equal(enqueued[0].message.contextToken, "ctx-2");
  assert.deepEqual(
    enqueued[0].message.prompt.map((block) => block.type === "text" ? block.text : block.type),
    ["first", "second"],
  );
});

test("media-led batches wait longer but flush quickly after text captions", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 15);
  const encrypted = encryptAesEcb(Buffer.from("caption target image"), aesKey);
  const config = defaultConfig();
  config.session.messageBatchDelayMs = 120;
  config.session.textMessageBatchDelayMs = 20;
  const bridge = new WeChatAcpBridge(config, () => {});
  const enqueued = [];
  bridge.sessionManager = {
    enqueue: async (userId, message) => {
      enqueued.push({ userId, message });
    },
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=cached-image/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  await bridge.handleMessage(imageMessage("ctx-1", "batch-img-msg", aesKey));
  await sleep(60);
  assert.equal(enqueued.length, 0);

  await bridge.handleMessage(textMessage("compare these", "ctx-2"));

  assert.equal(enqueued.length, 0);
  await sleep(60);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].message.contextToken, "ctx-2");
  assert.deepEqual(
    enqueued[0].message.prompt.map((block) => block.type === "text" ? block.text : block.type),
    ["image", "compare these"],
  );
});

test("quoted image stable msg_id resolves from media seen earlier in the session", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 11);
  const encrypted = encryptAesEcb(Buffer.from("cached image bytes"), aesKey);
  const config = defaultConfig();
  config.session.messageBatchDelayMs = 0;
  const enqueued = [];
  const logs = [];
  const bridge = new WeChatAcpBridge(config, (msg) => logs.push(msg));
  bridge.sessionManager = {
    enqueue: async (userId, message) => {
      enqueued.push({ userId, message });
    },
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=cached-image/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  await bridge.handleMessage(imageMessage("ctx-image", "img-msg-1", aesKey));
  await bridge.handleMessage(quotedImageMessageByMsgId("ctx-quote", "img-msg-1"));

  assert.equal(enqueued.length, 2);
  assert.ok(enqueued[1].message.prompt.some((block) => block.type === "image"));
  assert.ok(logs.some((msg) => msg.includes("Resolved quoted media from local cache")));
  assert.ok(logs.some((msg) => msg.includes("quoteMedia=image")));
});

test("quoted image stable msg_id resolves from persisted media cache after restart", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 12);
  const encrypted = encryptAesEcb(Buffer.from("cached image bytes"), aesKey);
  const config = defaultConfig();
  config.storage.dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-media-cache-"));
  config.session.messageBatchDelayMs = 0;
  const logs = [];
  const firstBridge = new WeChatAcpBridge(config, (msg) => logs.push(msg));
  firstBridge.sessionManager = {
    enqueue: async () => {},
  };
  const secondBridge = new WeChatAcpBridge(config, (msg) => logs.push(msg));
  const enqueued = [];
  secondBridge.sessionManager = {
    enqueue: async (userId, message) => {
      enqueued.push({ userId, message });
    },
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=cached-image/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  await firstBridge.handleMessage(imageMessage("ctx-image", "persisted-img-msg", aesKey));
  await secondBridge.handleMessage(quotedImageMessageByMsgId("ctx-quote", "persisted-img-msg"));

  assert.equal(enqueued.length, 1);
  assert.ok(enqueued[0].message.prompt.some((block) => block.type === "image"));
  assert.ok(logs.some((msg) => msg.includes("Resolved quoted media from persisted cache")));
  assert.ok(logs.some((msg) => msg.includes("quoteMedia=image")));
});

test("timestamp-only quoted image metadata does not reuse cached media automatically", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 13);
  const encrypted = encryptAesEcb(Buffer.from("cached image bytes"), aesKey);
  const config = defaultConfig();
  config.session.messageBatchDelayMs = 0;
  const enqueued = [];
  const logs = [];
  const bridge = new WeChatAcpBridge(config, (msg) => logs.push(msg));
  bridge.sessionManager = {
    enqueue: async (userId, message) => {
      enqueued.push({ userId, message });
    },
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=root-timestamp-image/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  await bridge.handleMessage(imageMessageWithRootTimestamp("ctx-image", 34567, aesKey));
  await bridge.handleMessage(quotedImageMessage("ctx-quote", 34567));

  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[1].message.prompt.some((block) => block.type === "image"), false);
  assert.ok(logs.some((msg) => msg.includes("Quoted media cache miss")));
  assert.ok(logs.some((msg) => msg.includes("Quote present but no extractable text/media")));
});

test("distant historical image quotes do not reuse recent cached media", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 14);
  const encrypted = encryptAesEcb(Buffer.from("cached image bytes"), aesKey);
  const config = defaultConfig();
  config.session.messageBatchDelayMs = 0;
  const enqueued = [];
  const logs = [];
  const bridge = new WeChatAcpBridge(config, (msg) => logs.push(msg));
  bridge.sessionManager = {
    enqueue: async (userId, message) => {
      enqueued.push({ userId, message });
    },
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=root-timestamp-image/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  await bridge.handleMessage(imageMessageWithRootTimestamp("ctx-image", 45678, aesKey));
  await bridge.handleMessage(quotedImageMessage("ctx-quote", 10_456_789));

  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[1].message.prompt.some((block) => block.type === "image"), false);
  assert.ok(logs.some((msg) => msg.includes("Quote present but no extractable text/media")));
});

function createBridge() {
  const bridge = new WeChatAcpBridge(defaultConfig(), () => {});
  bridge.tokenData = {
    token: "token",
    baseUrl: "https://ilink.test",
    accountId: "bot",
    userId: "bot",
    savedAt: new Date(0).toISOString(),
  };
  return bridge;
}

function textMessage(text, contextToken) {
  return {
    message_type: 1,
    from_user_id: "user-1",
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function imageMessage(contextToken, msgId, aesKey) {
  return {
    message_type: 1,
    from_user_id: "user-1",
    context_token: contextToken,
    item_list: [{
      type: 2,
      msg_id: msgId,
      image_item: {
        media: {
          encrypt_query_param: "cached-image",
          aes_key: aesKey.toString("base64"),
        },
      },
    }],
  };
}

function quotedImageMessageByMsgId(contextToken, msgId) {
  return {
    message_type: 1,
    from_user_id: "user-1",
    context_token: contextToken,
    item_list: [{
      type: 1,
      text_item: { text: "这是奥特曼和啥？" },
      ref_msg: {
        message_item: {
          msg_id: msgId,
          is_completed: true,
          button_item_list: [],
        },
      },
    }],
  };
}

function imageMessageWithRootTimestamp(contextToken, createTimeMs, aesKey) {
  return {
    message_type: 1,
    from_user_id: "user-1",
    context_token: contextToken,
    create_time_ms: createTimeMs,
    update_time_ms: createTimeMs,
    item_list: [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: "root-timestamp-image",
          aes_key: aesKey.toString("base64"),
        },
      },
    }],
  };
}

function quotedImageMessage(contextToken, createTimeMs) {
  return {
    message_type: 1,
    from_user_id: "user-1",
    context_token: contextToken,
    item_list: [{
      type: 1,
      text_item: { text: "这是奥特曼和啥？" },
      ref_msg: {
        message_item: {
          create_time_ms: createTimeMs,
          update_time_ms: createTimeMs,
          is_completed: true,
          button_item_list: [],
        },
      },
    }],
  };
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
