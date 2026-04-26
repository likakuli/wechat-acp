import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { weixinMessageToPrompt } from "../dist/src/adapter/inbound.js";

test("quoted image messages are attached to the ACP prompt", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 7);
  const encrypted = encryptAesEcb(Buffer.from("quoted image bytes"), aesKey);
  const logs = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=quote-param/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  const blocks = await weixinMessageToPrompt({
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{
      type: 1,
      text_item: { text: "这张图是什么意思" },
      ref_msg: {
        title: "quoted image",
        message_item: {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "quote-param",
              aes_key: aesKey.toString("base64"),
            },
          },
        },
      },
    }],
  }, "https://cdn.test", (msg) => logs.push(msg));

  assert.ok(blocks.some((block) => block.type === "image"));
  assert.ok(blocks.some((block) => block.type === "text" && block.text.includes("这张图是什么意思")));
  assert.ok(logs.some((msg) => msg.includes("Downloading quoted image from CDN")));
  assert.ok(logs.some((msg) => msg.includes("quoteMedia=image")));
});

test("quoted image thumbnails are attached even when the quoted item omits type", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 8);
  const encrypted = encryptAesEcb(Buffer.from("quoted thumbnail bytes"), aesKey);
  const logs = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=thumb-param/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  const blocks = await weixinMessageToPrompt({
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{
      type: 1,
      text_item: { text: "买哪个好呢" },
      ref_msg: {
        title: "quoted image thumbnail",
        message_item: {
          image_item: {
            thumb_media: {
              encrypt_query_param: "thumb-param",
              aes_key: aesKey.toString("base64"),
            },
          },
        },
      },
    }],
  }, "https://cdn.test", (msg) => logs.push(msg));

  assert.ok(blocks.some((block) => block.type === "image"));
  assert.ok(blocks.some((block) => block.type === "text" && block.text.includes("买哪个好呢")));
  assert.ok(logs.some((msg) => msg.includes("Downloading quoted image from CDN")));
  assert.ok(logs.some((msg) => msg.includes("quoteMedia=image")));
});

test("quoted images nested in quoted item lists are attached", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 9);
  const encrypted = encryptAesEcb(Buffer.from("nested quoted image bytes"), aesKey);
  const logs = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=nested-param/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  const blocks = await weixinMessageToPrompt({
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{
      type: 1,
      text_item: { text: "这是奥特曼和啥？" },
      ref_msg: {
        message_item: {
          item_list: [{
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: "nested-param",
                aes_key: aesKey.toString("base64"),
              },
            },
          }],
        },
      },
    }],
  }, "https://cdn.test", (msg) => logs.push(msg));

  assert.ok(blocks.some((block) => block.type === "image"));
  assert.ok(logs.some((msg) => msg.includes("Downloading quoted image from CDN")));
  assert.ok(logs.some((msg) => msg.includes("quoteMedia=image")));
});

test("quoted image metadata can resolve media from a local cache", async (t) => {
  const originalFetch = globalThis.fetch;
  const aesKey = Buffer.alloc(16, 10);
  const encrypted = encryptAesEcb(Buffer.from("cached quoted image bytes"), aesKey);
  const logs = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    assert.match(requestUrl, /encrypted_query_param=cached-param/);
    return new Response(new Uint8Array(encrypted), { status: 200 });
  };

  const cachedImage = {
    type: 2,
    create_time_ms: 12345,
    image_item: {
      media: {
        encrypt_query_param: "cached-param",
        aes_key: aesKey.toString("base64"),
      },
    },
  };

  const blocks = await weixinMessageToPrompt({
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{
      type: 1,
      text_item: { text: "这是奥特曼和啥？" },
      ref_msg: {
        message_item: {
          create_time_ms: 12345,
          update_time_ms: 12345,
          is_completed: true,
          button_item_list: [],
        },
      },
    }],
  }, "https://cdn.test", (msg) => logs.push(msg), {
    resolveQuotedMedia: (item) => item.create_time_ms === 12345 ? cachedImage : undefined,
  });

  assert.ok(blocks.some((block) => block.type === "image"));
  assert.ok(logs.some((msg) => msg.includes("Downloading quoted image from CDN")));
  assert.ok(logs.some((msg) => msg.includes("quoteMedia=image")));
});

test("quoted text emits a privacy-preserving observability log", async () => {
  const logs = [];
  const quotedText = "这是一段用于测试的历史文本，不应该完整出现在日志里面";

  const blocks = await weixinMessageToPrompt({
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{
      type: 1,
      text_item: { text: "基于引用回答" },
      ref_msg: {
        title: "历史标题",
        message_item: {
          type: 1,
          text_item: { text: quotedText },
        },
      },
    }],
  }, "https://cdn.test", (msg) => logs.push(msg));

  assert.ok(blocks.some((block) => (
    block.type === "text" &&
    block.text.includes(quotedText) &&
    block.text.includes("基于引用回答")
  )));
  assert.ok(logs.some((msg) => (
    msg.includes(`Quote text attached: title=4 chars, body=${quotedText.length} chars`)
  )));
  assert.ok(logs.some((msg) => msg.includes("quoteText=true")));
  assert.ok(!logs.some((msg) => msg.includes(quotedText)));
});

test("unsupported quote payloads are visible in logs without content", async () => {
  const logs = [];

  const blocks = await weixinMessageToPrompt({
    message_type: 1,
    from_user_id: "user-1",
    context_token: "ctx-1",
    item_list: [{
      type: 1,
      text_item: { text: "引用没解析到" },
      ref_msg: {
        message_item: {
          type: 2,
        },
      },
    }],
  }, "https://cdn.test", (msg) => logs.push(msg));

  assert.ok(blocks.some((block) => block.type === "text" && block.text === "引用没解析到"));
  assert.ok(logs.some((msg) => (
    msg.includes("Quote present but no extractable text/media") &&
    msg.includes("refKeys=message_item") &&
    msg.includes("messageItemType=2") &&
    msg.includes("messageItemKeys=type")
  )));
});

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
