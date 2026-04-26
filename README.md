# WeChat ACP

Bridge WeChat direct messages to any ACP-compatible AI agent.

`wechat-acp` logs in with the WeChat iLink bot API, polls incoming 1:1 messages, forwards them to an ACP agent over stdio, and sends the agent reply back to WeChat.

<img src="./resources/screenshot.jpg" alt="wechat-acp screenshot" width="400" />

## Features

- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in ACP agent presets for common CLIs
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats are ignored
- Background daemon mode

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with a built-in agent preset:

```bash
npx @likakuli/wechat-acp --agent copilot
```

Or use a raw custom command:

```bash
npx @likakuli/wechat-acp --agent "npx my-agent --acp"
```

On first run, the bridge will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the login token under `~/.wechat-acp`
4. Begin polling direct messages

## Built-in Agent Presets

List the bundled presets:

```bash
npx @likakuli/wechat-acp agents
```

Current presets:

- `copilot`
- `claude`
- `gemini`
- `qwen`
- `codex`
- `opencode`

These presets resolve to concrete `command + args` pairs internally, so users do not need to type long `npx ...` commands.

## CLI Usage

```text
wechat-acp --agent <preset|command> [options]
wechat-acp agents
wechat-acp stop
wechat-acp status
```

Options:

- `--agent <value>`: built-in preset name or raw agent command
- `--cwd <dir>`: working directory for the agent process
- `--login`: force QR re-login and replace the saved token
- `--daemon`: run in background after startup
- `--config <file>`: load JSON config file
- `--idle-timeout <minutes>`: session idle timeout, default `1440` (use `0` for unlimited)
- `--max-sessions <count>`: maximum concurrent user sessions, default `10`
- `--message-batch-delay <ms>`: batch media-led messages from the same user into one agent prompt, default `2500` (use `0` to disable batching)
- `--text-batch-delay <ms>`: batch nearby text messages from the same user, default `800`
- `--max-send-messages <count>`: maximum WeChat `sendmessage` calls per reply, default `10`
- `--show-thoughts`: forward agent thinking to WeChat (default: off)
- `-h, --help`: show help

Examples:

```bash
npx @likakuli/wechat-acp --agent copilot
npx @likakuli/wechat-acp --agent claude --cwd D:\code\project
npx @likakuli/wechat-acp --agent "npx @github/copilot --acp"
npx @likakuli/wechat-acp --agent gemini --daemon
```

## Configuration File

You can provide a JSON config file with `--config`.

Example:

```json
{
  "agent": {
    "preset": "copilot",
    "cwd": "D:/code/project"
  },
  "session": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentUsers": 10,
    "messageBatchDelayMs": 2500,
    "textMessageBatchDelayMs": 800
  },
  "wechat": {
    "maxSendMessagesPerReply": 10
  }
}
```

You can also override or add agent presets:

```json
{
  "agent": {
    "preset": "my-agent"
  },
  "agents": {
    "my-agent": {
      "label": "My Agent",
      "description": "Internal team agent",
      "command": "npx",
      "args": ["my-agent-cli", "--acp"]
    }
  }
}
```

## Runtime Behavior

- Each WeChat user gets a dedicated ACP session and subprocess.
- Nearby messages from the same user are batched into one ACP prompt, then prompts are processed serially per user. Media-led batches use the longer `messageBatchDelayMs` window so captions can arrive; text-only batches use the shorter `textMessageBatchDelayMs` window.
- Text quotes are included in the ACP prompt when iLink includes quoted text in `ref_msg`.
- Image quotes are attached when iLink includes `ref_msg.message_item.image_item` media, or when a stable `msg_id`/`message_id` can be resolved from the local quoted media cache.
- Replies are formatted for WeChat before sending.
- Typing indicators are sent when supported by the WeChat API.
- Sessions are cleaned up after inactivity (set `idleTimeoutMs` to `0` to disable idle cleanup).

## Storage

By default, runtime files are stored under:

```text
~/.wechat-acp
```

This directory is used for:

- saved login token
- daemon pid file
- daemon log file
- sync state
- quoted media cache for images previously seen by the bridge

## Current Limitations

- Direct messages only; group chats are ignored
- MCP servers are not used
- Permission requests are auto-approved
- Agent communication is subprocess-only over stdio
- Historical quoted images cannot be recovered when iLink only returns quote metadata and the bridge has no cached stable message id for the original image.
- Some preset agents may require separate authentication before they can respond successfully

## Development

For local development:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/bin/wechat-acp.js --help
```

Watch mode:

```bash
npm run dev
```

## License

MIT
