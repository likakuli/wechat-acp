import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sendImageMessage, sendTextMessage } from "../dist/src/weixin/send.js";
import { MessageItemType, UploadMediaType } from "../dist/src/weixin/types.js";

test("send diagnostics identify image sequence and later text rejection", async (t) => {
  const originalFetch = globalThis.fetch;
  const sendBodies = [];
  let sendCount = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes("ilink/bot/getuploadurl")) {
      return jsonResponse({
        ret: 0,
        upload_full_url: "https://cdn.test/upload",
      });
    }

    if (requestUrl.includes("cdn.test/upload")) {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": `download-param-${sendBodies.length}` },
      });
    }

    if (requestUrl.includes("ilink/bot/sendmessage")) {
      sendCount += 1;
      const body = JSON.parse(String(init.body));
      sendBodies.push(body);
      return jsonResponse({ ret: sendCount > 10 ? -2 : 0 });
    }

    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const image = {
    buffer: Buffer.from("diagnostic image payload"),
    mimeType: "image/png",
    name: "diagnostic.png",
  };
  const imageFailures = [];

  for (let i = 1; i <= 12; i++) {
    try {
      await sendImageMessage("user-1", image, {
        baseUrl: "https://ilink.test",
        cdnBaseUrl: "https://cdn.test",
        token: "token",
        contextToken: "ctx-images",
        debug: { index: i, total: 12, label: `image-${i}` },
      });
    } catch (err) {
      imageFailures.push(String(err));
    }
  }

  assert.equal(imageFailures.length, 2);
  assert.match(imageFailures[0], /send image failed/);
  assert.match(imageFailures[0], /index=11\/12/);
  assert.match(imageFailures[0], /contextHash=/);
  assert.match(imageFailures[0], /body=\{"ret":-2\}/);
  assert.match(imageFailures[1], /index=12\/12/);

  await assert.rejects(
    () => sendTextMessage("user-1", "later text", {
      baseUrl: "https://ilink.test",
      token: "token",
      contextToken: "ctx-later",
      debug: { index: 1, total: 1 },
    }),
    /send text failed/,
  );

  assert.equal(sendBodies.length, 13);
  assert.equal(sendBodies[10].msg.context_token, "ctx-images");
  assert.equal(sendBodies[11].msg.context_token, "ctx-images");
  assert.equal(sendBodies[12].msg.context_token, "ctx-later");
  assert.equal(sendBodies[12].msg.item_list[0].type, 1);
});

test("sendmessage carries official iLink headers for large image batches", async (t) => {
  const originalFetch = globalThis.fetch;
  const sendHeaders = [];
  let sendCount = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes("ilink/bot/getuploadurl")) {
      return jsonResponse({
        ret: 0,
        upload_full_url: "https://cdn.test/upload",
      });
    }

    if (requestUrl.includes("cdn.test/upload")) {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      });
    }

    if (requestUrl.includes("ilink/bot/sendmessage")) {
      sendCount += 1;
      const headers = headerObject(init.headers);
      sendHeaders.push(headers);

      const hasOfficialHeaders = headers["ilink-app-id"] === "bot"
        && headers["ilink-app-clientversion"] === "65538"
        && Number(headers["content-length"]) > 0;

      return jsonResponse({ ret: hasOfficialHeaders ? 0 : -2 });
    }

    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const image = {
    buffer: Buffer.from("diagnostic image payload"),
    mimeType: "image/png",
    name: "diagnostic.png",
  };

  for (let i = 1; i <= 12; i++) {
    await sendImageMessage("user-1", image, {
      baseUrl: "https://ilink.test",
      cdnBaseUrl: "https://cdn.test",
      token: "token",
      contextToken: "ctx-images",
      debug: { index: i, total: 12, label: `image-${i}` },
    });
  }

  assert.equal(sendCount, 12);
  assert.equal(sendHeaders.length, 12);
  for (const headers of sendHeaders) {
    assert.equal(headers["authorizationtype"], "ilink_bot_token");
    assert.equal(headers["ilink-app-id"], "bot");
    assert.equal(headers["ilink-app-clientversion"], "65538");
    assert.ok(Number(headers["content-length"]) > 0);
    assert.match(headers["x-wechat-uin"], /^[A-Za-z0-9+/]+={0,2}$/);
  }
});

test("image payload stays valid and unique across a 12 image batch", async (t) => {
  const originalFetch = globalThis.fetch;
  const uploadUrlBodies = [];
  const cdnUploads = [];
  const sendBodies = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes("ilink/bot/getuploadurl")) {
      const body = JSON.parse(String(init.body));
      uploadUrlBodies.push(body);
      return jsonResponse({
        ret: 0,
        upload_full_url: `https://cdn.test/upload/${uploadUrlBodies.length}`,
      });
    }

    if (requestUrl.includes("cdn.test/upload")) {
      cdnUploads.push({
        url: requestUrl,
        size: bodySize(init.body),
      });
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": `download-param-${cdnUploads.length}` },
      });
    }

    if (requestUrl.includes("ilink/bot/sendmessage")) {
      sendBodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ ret: 0 });
    }

    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const image = {
    buffer: Buffer.from("diagnostic image payload"),
    mimeType: "image/png",
    name: "diagnostic.png",
  };

  for (let i = 1; i <= 12; i++) {
    await sendImageMessage("user-1", image, {
      baseUrl: "https://ilink.test",
      cdnBaseUrl: "https://cdn.test",
      token: "token",
      contextToken: "ctx-images",
      debug: { index: i, total: 12, label: `image-${i}` },
    });
  }

  assert.equal(uploadUrlBodies.length, 12);
  assert.equal(cdnUploads.length, 12);
  assert.equal(sendBodies.length, 12);

  const clientIds = new Set();
  const filekeys = new Set();
  const rawsize = image.buffer.length;
  const filesize = aesEcbPaddedSize(rawsize);
  const rawfilemd5 = md5Hex(image.buffer);

  for (let i = 0; i < 12; i++) {
    const upload = uploadUrlBodies[i];
    assert.equal(upload.media_type, UploadMediaType.IMAGE);
    assert.equal(upload.to_user_id, "user-1");
    assert.equal(upload.rawsize, rawsize);
    assert.equal(upload.rawfilemd5, rawfilemd5);
    assert.equal(upload.filesize, filesize);
    assert.equal(upload.no_need_thumb, true);
    assert.match(upload.filekey, /^[0-9a-f]{32}$/);
    assert.match(upload.aeskey, /^[0-9a-f]{32}$/);
    assert.equal(upload.base_info.channel_version, "1.0.2");
    filekeys.add(upload.filekey);

    assert.equal(cdnUploads[i].size, filesize);

    const msg = sendBodies[i].msg;
    assert.equal(msg.to_user_id, "user-1");
    assert.equal(msg.context_token, "ctx-images");
    assert.equal(msg.message_type, 2);
    assert.equal(msg.message_state, 2);
    assert.match(msg.client_id, /^wechat-acp-/);
    clientIds.add(msg.client_id);

    const item = msg.item_list[0];
    assert.equal(item.type, MessageItemType.IMAGE);
    assert.equal(item.image_item.mid_size, filesize);
    assert.equal(item.image_item.media.encrypt_query_param, `download-param-${i + 1}`);
    assert.equal(item.image_item.media.encrypt_type, 1);
    assert.equal(Buffer.from(item.image_item.media.aes_key, "base64").toString("ascii"), upload.aeskey);
  }

  assert.equal(clientIds.size, 12);
  assert.equal(filekeys.size, 12);
});

test("old context token alone does not explain later text failure", async (t) => {
  const originalFetch = globalThis.fetch;
  const outcomes = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
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
      const body = JSON.parse(String(init.body));
      const ret = body.msg.context_token === "ctx-images" ? -2 : 0;
      outcomes.push({ type: body.msg.item_list[0].type, contextToken: body.msg.context_token, ret });
      return jsonResponse({ ret });
    }

    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  await assert.rejects(
    () => sendImageMessage("user-1", {
      buffer: Buffer.from("diagnostic image payload"),
      mimeType: "image/png",
      name: "diagnostic.png",
    }, {
      baseUrl: "https://ilink.test",
      cdnBaseUrl: "https://cdn.test",
      token: "token",
      contextToken: "ctx-images",
      debug: { index: 11, total: 12 },
    }),
    /ret=-2/,
  );

  await sendTextMessage("user-1", "later text", {
    baseUrl: "https://ilink.test",
    token: "token",
    contextToken: "ctx-later",
    debug: { index: 1, total: 1 },
  });

  assert.deepEqual(outcomes, [
    { type: MessageItemType.IMAGE, contextToken: "ctx-images", ret: -2 },
    { type: MessageItemType.TEXT, contextToken: "ctx-later", ret: 0 },
  ]);
});

test("send window rejection model matches image failures and immediate later text failure", async (t) => {
  const originalFetch = globalThis.fetch;
  let sendCount = 0;
  const outcomes = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
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
      sendCount += 1;
      const body = JSON.parse(String(init.body));
      const ret = sendCount > 10 ? -2 : 0;
      outcomes.push({ n: sendCount, type: body.msg.item_list[0].type, contextToken: body.msg.context_token, ret });
      return jsonResponse({ ret });
    }

    throw new Error(`unexpected fetch: ${requestUrl}`);
  };

  const image = {
    buffer: Buffer.from("diagnostic image payload"),
    mimeType: "image/png",
    name: "diagnostic.png",
  };

  for (let i = 1; i <= 12; i++) {
    try {
      await sendImageMessage("user-1", image, {
        baseUrl: "https://ilink.test",
        cdnBaseUrl: "https://cdn.test",
        token: "token",
        contextToken: "ctx-images",
        debug: { index: i, total: 12 },
      });
    } catch {
      // The model rejects messages after the 10th send.
    }
  }

  await assert.rejects(
    () => sendTextMessage("user-1", "later text", {
      baseUrl: "https://ilink.test",
      token: "token",
      contextToken: "ctx-later",
      debug: { index: 1, total: 1 },
    }),
    /ret=-2/,
  );

  assert.equal(outcomes[9].ret, 0);
  assert.deepEqual(outcomes.slice(10).map((outcome) => ({
    n: outcome.n,
    type: outcome.type,
    contextToken: outcome.contextToken,
    ret: outcome.ret,
  })), [
    { n: 11, type: MessageItemType.IMAGE, contextToken: "ctx-images", ret: -2 },
    { n: 12, type: MessageItemType.IMAGE, contextToken: "ctx-images", ret: -2 },
    { n: 13, type: MessageItemType.TEXT, contextToken: "ctx-later", ret: -2 },
  ]);
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function headerObject(headers) {
  const result = {};
  if (headers instanceof Headers) {
    for (const [key, value] of headers) result[key.toLowerCase()] = value;
    return result;
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key.toLowerCase()] = String(value);
  }
  return result;
}

function bodySize(body) {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  throw new Error(`unsupported body type: ${typeof body}`);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function md5Hex(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}
