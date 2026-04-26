import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WeChatAcpClient } from "../dist/src/acp/client.js";

test("ACP file access is constrained to the configured root directory", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-fs-"));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside.txt");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "inside.txt"), "inside", "utf-8");
  await fs.writeFile(outside, "outside", "utf-8");

  const client = new WeChatAcpClient({
    rootDir: root,
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    log: () => {},
    showThoughts: false,
  });

  assert.deepEqual(
    await client.readTextFile({ path: "inside.txt" }),
    { content: "inside" },
  );

  await assert.rejects(
    () => client.readTextFile({ path: outside }),
    /outside.*workspace|not allowed|root/i,
  );

  await assert.rejects(
    () => client.writeTextFile({ path: outside, content: "changed" }),
    /outside.*workspace|not allowed|root/i,
  );

  assert.equal(await fs.readFile(outside, "utf-8"), "outside");
});
