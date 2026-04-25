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
const DEFAULT_MAX_SEND_MESSAGES_PER_REPLY = 10;

interface PendingOverflowReply {
  textSegments: string[];
  images: AgentImage[];
}

export interface OutboundReplyPlan<TImage> {
  maxSendMessages: number;
  textSegments: string[];
  images: TImage[];
  overflowTextSegments: string[];
  overflowImages: TImage[];
  noticeText?: string;
}

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private pendingOverflowReplies = new Map<string, PendingOverflowReply>();
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

    if (this.shouldContinuePendingReply(userId, msg)) {
      this.continuePendingReply(userId, contextToken).catch((err) => {
        this.log(`Failed to continue pending reply for ${userId}: ${String(err)}`);
      });
      return;
    }

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
    await this.sendReplyParts(userId, contextToken, segments, reply.images);
  }

  private async sendReplyParts(
    userId: string,
    contextToken: string,
    textSegments: string[],
    images: AgentImage[],
  ): Promise<void> {
    const plan = planOutboundReply(
      textSegments,
      images,
      this.config.wechat.maxSendMessagesPerReply,
    );

    if (plan.overflowTextSegments.length > 0 || plan.overflowImages.length > 0) {
      this.pendingOverflowReplies.set(userId, {
        textSegments: plan.overflowTextSegments,
        images: plan.overflowImages,
      });
      this.log(
        `Reply for ${userId} exceeds ${plan.maxSendMessages} WeChat messages; ` +
        `sending ${plan.textSegments.length} text segments, ${plan.images.length} images, ` +
        `holding ${plan.overflowTextSegments.length} text segments, ${plan.overflowImages.length} images`,
      );
    } else {
      this.pendingOverflowReplies.delete(userId);
    }

    for (let i = 0; i < plan.textSegments.length; i++) {
      const segment = plan.textSegments[i]!;
      try {
        const clientId = await sendTextMessage(userId, segment, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          debug: { index: i + 1, total: plan.textSegments.length },
        });
        this.log(`Sent text to ${userId}: ${i + 1}/${plan.textSegments.length}, ${segment.length} chars (${clientId})`);
      } catch (err) {
        this.log(`Failed to send text to ${userId}: ${String(err)}`);
        throw err;
      }
    }

    for (let i = 0; i < plan.images.length; i++) {
      const image = plan.images[i]!;
      try {
        const resolved = await this.resolveAgentImage(image);
        const clientId = await sendImageMessage(userId, resolved, {
          baseUrl: this.tokenData!.baseUrl,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          token: this.tokenData!.token,
          contextToken,
          debug: {
            index: i + 1,
            total: plan.images.length,
            label: image.name ?? image.uri ?? image.mimeType,
          },
        });
        this.log(`Sent image to ${userId}: ${i + 1}/${plan.images.length}, ${image.name ?? image.uri ?? image.mimeType} (${clientId})`);
      } catch (err) {
        this.log(`Failed to send image to ${userId}: ${String(err)}`);
      }
    }

    if (plan.noticeText) {
      try {
        const clientId = await sendTextMessage(userId, plan.noticeText, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          debug: { index: 1, total: 1, label: "overflow-notice" },
        });
        this.log(`Sent overflow notice to ${userId}: ${plan.noticeText.length} chars (${clientId})`);
      } catch (err) {
        this.log(`Failed to send overflow notice to ${userId}: ${String(err)}`);
        throw err;
      }
    }

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async continuePendingReply(userId: string, contextToken: string): Promise<void> {
    const pending = this.pendingOverflowReplies.get(userId);
    if (!pending) return;

    this.pendingOverflowReplies.delete(userId);
    this.log(`Continuing pending reply for ${userId}: ${pending.textSegments.length} text segments, ${pending.images.length} images`);
    await this.sendReplyParts(userId, contextToken, pending.textSegments, pending.images);
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

  private shouldContinuePendingReply(userId: string, msg: WeixinMessage): boolean {
    if (!this.pendingOverflowReplies.has(userId)) return false;
    const text = extractMessageText(msg).trim().replace(/\s+/g, "");
    if (!text || text.length > 20) return false;
    if (text.includes("不用") || text.includes("不要")) return false;
    return text.includes("继续") || text.includes("补发") || text.includes("剩余") || text.includes("剩下");
  }
}

export function normalizeMaxSendMessagesPerReply(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_MAX_SEND_MESSAGES_PER_REPLY;
  return Math.max(2, Math.floor(value));
}

export function planOutboundReply<TImage>(
  textSegments: string[],
  images: TImage[],
  maxSendMessagesPerReply: number | undefined,
): OutboundReplyPlan<TImage> {
  const maxSendMessages = normalizeMaxSendMessagesPerReply(maxSendMessagesPerReply);
  const totalMessages = textSegments.length + images.length;

  if (totalMessages <= maxSendMessages) {
    return {
      maxSendMessages,
      textSegments,
      images,
      overflowTextSegments: [],
      overflowImages: [],
    };
  }

  const sendBudget = maxSendMessages - 1;
  const sendTextCount = Math.min(textSegments.length, sendBudget);
  const sendImageCount = Math.max(0, Math.min(images.length, sendBudget - sendTextCount));
  const sentTextSegments = textSegments.slice(0, sendTextCount);
  const sentImages = images.slice(0, sendImageCount);
  const overflowTextSegments = textSegments.slice(sendTextCount);
  const overflowImages = images.slice(sendImageCount);

  return {
    maxSendMessages,
    textSegments: sentTextSegments,
    images: sentImages,
    overflowTextSegments,
    overflowImages,
    noticeText: buildOverflowNotice({
      maxSendMessages,
      sentTextSegments: sentTextSegments.length,
      totalTextSegments: textSegments.length,
      sentImages: sentImages.length,
      totalImages: images.length,
      overflowTextSegments: overflowTextSegments.length,
      overflowImages: overflowImages.length,
    }),
  };
}

function buildOverflowNotice(stats: {
  maxSendMessages: number;
  sentTextSegments: number;
  totalTextSegments: number;
  sentImages: number;
  totalImages: number;
  overflowTextSegments: number;
  overflowImages: number;
}): string {
  const details: string[] = [`本次最多发送 ${stats.maxSendMessages} 条微信消息`];
  if (stats.totalTextSegments > 0) {
    details.push(`已发送 ${stats.sentTextSegments}/${stats.totalTextSegments} 段文本`);
  }
  if (stats.totalImages > 0) {
    details.push(`已发送 ${stats.sentImages}/${stats.totalImages} 张图片`);
  }
  if (stats.overflowTextSegments > 0) {
    details.push(`还有 ${stats.overflowTextSegments} 段文本未发送`);
  }
  if (stats.overflowImages > 0) {
    details.push(`还有 ${stats.overflowImages} 张图片未发送`);
  }
  return `${details.join("，")}。回复“继续”获取剩余内容。`;
}

function extractMessageText(msg: WeixinMessage): string {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return item.voice_item.text;
  }
  return "";
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
