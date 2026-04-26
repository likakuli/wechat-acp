import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseAgentCommand } from "../dist/src/config.js";

test("raw agent command parsing preserves quoted arguments", () => {
  assert.deepEqual(
    parseAgentCommand('npx my-agent --label "hello world" --path "a b/c"'),
    {
      command: "npx",
      args: ["my-agent", "--label", "hello world", "--path", "a b/c"],
    },
  );

  assert.throws(
    () => parseAgentCommand('npx my-agent "unterminated'),
    /unterminated/i,
  );
});

test("CLI rejects invalid max session counts before starting the bridge", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/bin/wechat-acp.js", "--agent", "copilot", "--max-sessions", "-1"],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 1_000,
    },
  );

  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --max-sessions/i);
});

test("CLI rejects invalid text batch delays before starting the bridge", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/bin/wechat-acp.js", "--agent", "copilot", "--text-batch-delay", "-1"],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 1_000,
    },
  );

  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid --text-batch-delay/i);
});
