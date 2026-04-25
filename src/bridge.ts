/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendImageMessage, sendTextMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import type { AgentImage, AgentReply } from "./acp/client.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { WeChatAcpConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private log: (msg: string) => void;

  constructor(config: WeChatAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-acp] ${msg}`));
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    // 1. Login or load token
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
    }

    if (!this.tokenData) {
      this.tokenData = await login({
        baseUrl: this.config.wechat.baseUrl,
        botType: this.config.wechat.botType,
        storageDir: this.config.storage.dir,
        log: this.log,
        renderQrUrl,
      });
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log(`Use --login to force re-login`);
    }

    // 2. Create SessionManager
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (userId, contextToken, reply) => this.sendReply(userId, contextToken, reply),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
    });
    this.sessionManager.start();

    // 3. Start monitor loop
    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    await this.sessionManager?.stop();
    this.log("Bridge stopped");
  }

  private handleMessage(msg: WeixinMessage): void {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    // Convert and enqueue — fire-and-forget (don't block the poll loop)
    this.enqueueMessage(msg, userId, contextToken).catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
    });
  }

  private async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
    );

    await this.sessionManager!.enqueue(userId, { prompt, contextToken });
  }

  private async sendReply(userId: string, contextToken: string, reply: AgentReply): Promise<void> {
    const formatted = formatForWeChat(reply.text);
    const segments = formatted.trim() ? splitText(formatted, TEXT_CHUNK_LIMIT) : [];

    for (const segment of segments) {
      const clientId = await sendTextMessage(userId, segment, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
      });
      this.log(`Sent text to ${userId}: ${segment.length} chars (${clientId})`);
    }

    for (const image of reply.images) {
      try {
        const resolved = await this.resolveAgentImage(image);
        await sendImageMessage(userId, resolved, {
          baseUrl: this.tokenData!.baseUrl,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          token: this.tokenData!.token,
          contextToken,
        });
        this.log(`Sent image to ${userId}: ${image.name ?? image.uri ?? image.mimeType}`);
      } catch (err) {
        this.log(`Failed to send image to ${userId}: ${String(err)}`);
      }
    }

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async resolveAgentImage(image: AgentImage): Promise<{ buffer: Buffer; mimeType?: string; name?: string }> {
    if (image.data) {
      return {
        buffer: Buffer.from(stripDataPrefix(image.data), "base64"),
        mimeType: image.mimeType,
        name: image.name,
      };
    }

    if (!image.uri) {
      throw new Error("image has neither data nor uri");
    }

    const dataUri = parseDataUri(image.uri);
    if (dataUri) {
      return {
        buffer: Buffer.from(dataUri.base64, "base64"),
        mimeType: dataUri.mimeType ?? image.mimeType,
        name: image.name,
      };
    }

    if (/^https?:\/\//i.test(image.uri)) {
      const res = await fetch(image.uri);
      if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type") ?? image.mimeType,
        name: image.name,
      };
    }

    const filePath = resolveLocalPath(image.uri, this.config.agent.cwd);
    return {
      buffer: await fs.readFile(filePath),
      mimeType: image.mimeType,
      name: image.name ?? path.basename(filePath),
    };
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;

    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  private async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;

      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // Typing is best-effort
    }
  }

  private async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;

    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: userId,
        contextToken,
      });

      if (resp.typing_ticket) {
        this.typingTickets.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + 24 * 60 * 60_000, // 24h cache
        });
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }
}

function stripDataPrefix(data: string): string {
  const match = /^data:[^;]+;base64,([\s\S]*)$/i.exec(data.trim());
  return match?.[1] ?? data;
}

function parseDataUri(uri: string): { mimeType?: string; base64: string } | null {
  const match = /^data:([^;]+)?;base64,([\s\S]*)$/i.exec(uri.trim());
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2],
  };
}

function resolveLocalPath(uri: string, cwd: string): string {
  const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
