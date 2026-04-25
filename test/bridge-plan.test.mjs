import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMaxSendMessagesPerReply,
  planOutboundReply,
} from "../dist/src/bridge.js";

test("reply plan reserves one slot for overflow notice", () => {
  const images = Array.from({ length: 12 }, (_, i) => ({ name: `image-${i + 1}` }));
  const plan = planOutboundReply([], images, 10);

  assert.equal(plan.maxSendMessages, 10);
  assert.equal(plan.textSegments.length, 0);
  assert.equal(plan.images.length, 9);
  assert.equal(plan.overflowImages.length, 3);
  assert.match(plan.noticeText, /已发送 9\/12 张图片/);
  assert.equal(plan.textSegments.length + plan.images.length + 1, 10);
});

test("reply plan counts text and image sends in the same budget", () => {
  const images = Array.from({ length: 12 }, (_, i) => ({ name: `image-${i + 1}` }));
  const plan = planOutboundReply(["summary"], images, 10);

  assert.deepEqual(plan.textSegments, ["summary"]);
  assert.equal(plan.images.length, 8);
  assert.equal(plan.overflowTextSegments.length, 0);
  assert.equal(plan.overflowImages.length, 4);
  assert.match(plan.noticeText, /已发送 1\/1 段文本/);
  assert.match(plan.noticeText, /已发送 8\/12 张图片/);
  assert.equal(plan.textSegments.length + plan.images.length + 1, 10);
});

test("reply plan does not add notice when reply fits", () => {
  const images = Array.from({ length: 2 }, (_, i) => ({ name: `image-${i + 1}` }));
  const plan = planOutboundReply(["summary"], images, 10);

  assert.deepEqual(plan.textSegments, ["summary"]);
  assert.equal(plan.images.length, 2);
  assert.equal(plan.overflowTextSegments.length, 0);
  assert.equal(plan.overflowImages.length, 0);
  assert.equal(plan.noticeText, undefined);
});

test("max send message config has a default and minimum", () => {
  assert.equal(normalizeMaxSendMessagesPerReply(undefined), 10);
  assert.equal(normalizeMaxSendMessagesPerReply(Number.NaN), 10);
  assert.equal(normalizeMaxSendMessagesPerReply(1), 2);
  assert.equal(normalizeMaxSendMessagesPerReply(10.8), 10);
});
