import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionManager } from "../dist/src/acp/session.js";

test("concurrent messages for the same user share one session creation", async () => {
  const spawnCalls = [];
  const prompts = [];
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => {
    releaseSpawn = resolve;
  });

  const manager = new SessionManager({
    agentCommand: "fake-agent",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 10,
    showThoughts: false,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
    spawnAgent: async (params) => {
      spawnCalls.push(params);
      await spawnGate;
      return {
        process: new FakeProcess(),
        sessionId: "session-1",
        connection: {
          prompt: async (request) => {
            prompts.push(request.prompt);
            return { stopReason: "end_turn" };
          },
        },
      };
    },
  });

  const first = manager.enqueue("user-1", {
    prompt: [{ type: "text", text: "first" }],
    contextToken: "ctx-1",
  });
  const second = manager.enqueue("user-1", {
    prompt: [{ type: "text", text: "second" }],
    contextToken: "ctx-2",
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(spawnCalls.length, 1);

  releaseSpawn();
  await Promise.all([first, second]);
  await waitFor(() => prompts.length === 2);

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(
    prompts.map((prompt) => prompt[0].text),
    ["first", "second"],
  );

  await manager.stop();
});

test("concurrent new users do not bypass the session limit", async () => {
  const spawnCalls = [];
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => {
    releaseSpawn = resolve;
  });

  const manager = new SessionManager({
    agentCommand: "fake-agent",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    showThoughts: false,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
    spawnAgent: async (params) => {
      spawnCalls.push(params);
      await spawnGate;
      return {
        process: new FakeProcess(),
        sessionId: `session-${spawnCalls.length}`,
        connection: {
          prompt: async () => ({ stopReason: "end_turn" }),
        },
      };
    },
  });

  const first = manager.enqueue("user-1", {
    prompt: [{ type: "text", text: "first" }],
    contextToken: "ctx-1",
  });

  const second = manager.enqueue("user-2", {
      prompt: [{ type: "text", text: "second" }],
      contextToken: "ctx-2",
    })
    .then(() => ({ resolved: true }))
    .catch((err) => ({ resolved: false, err }));

  await Promise.resolve();
  await Promise.resolve();
  const callsBeforeRelease = spawnCalls.length;
  releaseSpawn();
  await first;
  const secondOutcome = await second;

  assert.equal(callsBeforeRelease, 1);
  assert.equal(secondOutcome.resolved, false);
  assert.match(String(secondOutcome.err), /maximum concurrent/i);
  await manager.stop();
});

test("agent prompt capabilities are honored before sending optional content blocks", async () => {
  const prompts = [];

  const manager = new SessionManager({
    agentCommand: "fake-agent",
    agentArgs: [],
    agentCwd: process.cwd(),
    idleTimeoutMs: 0,
    maxConcurrentUsers: 1,
    showThoughts: false,
    log: () => {},
    onReply: async () => {},
    sendTyping: async () => {},
    spawnAgent: async () => ({
      process: new FakeProcess(),
      sessionId: "session-1",
      promptCapabilities: {
        image: false,
        embeddedContext: false,
      },
      connection: {
        prompt: async (request) => {
          prompts.push(request.prompt);
          return { stopReason: "end_turn" };
        },
      },
    }),
  });

  await manager.enqueue("user-1", {
    prompt: [
      { type: "text", text: "please inspect this" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      {
        type: "resource",
        resource: {
          uri: "file:///note.txt",
          mimeType: "text/plain",
          text: "quoted text file",
        },
      },
    ],
    contextToken: "ctx-1",
  });

  await waitFor(() => prompts.length === 1);
  assert.deepEqual(
    prompts[0].map((block) => block.type),
    ["text", "text", "text"],
  );
  assert.match(prompts[0][1].text, /image.*not supported/i);
  assert.match(prompts[0][2].text, /quoted text file/);

  await manager.stop();
});

class FakeProcess extends EventEmitter {
  killed = false;
  exitCode = null;

  kill(signal) {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, signal);
    return true;
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "condition was not met before timeout");
}
