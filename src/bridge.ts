/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendImageMessage, sendTextMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { MessageItem, WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import type { AgentImage, AgentReply } from "./acp/client.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { WeChatAcpConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;
const DEFAULT_MAX_SEND_MESSAGES_PER_REPLY = 10;
const DEFAULT_MESSAGE_BATCH_DELAY_MS = 2500;
const DEFAULT_TEXT_MESSAGE_BATCH_DELAY_MS = 800;
const QUOTED_MEDIA_CACHE_LIMIT_PER_USER = 100;
const QUOTED_MEDIA_CACHE_TTL_MS = 24 * 60 * 60_000;
const QUOTED_MEDIA_CACHE_FILE = "quoted-media-cache.json";

interface PendingOverflowReply {
  textSegments: string[];
  images: AgentImage[];
}

interface PendingMessageBatch {
  prompt: acp.ContentBlock[];
  contextToken: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CachedQuotedMedia {
  item: MessageItem;
  keys: Set<string>;
  timestamps: number[];
  cachedAt: number;
  source: "memory" | "persisted";
}

interface SerializedQuotedMediaCacheEntry {
  userId: string;
  item: MessageItem;
  keys: string[];
  timestamps?: number[];
  cachedAt: number;
}

interface SerializedQuotedMediaCache {
  version: 1;
  entries: SerializedQuotedMediaCacheEntry[];
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
  private pendingMessageBatches = new Map<string, PendingMessageBatch>();
  private quotedMediaCache = new Map<string, CachedQuotedMedia[]>();
  private quotedMediaCacheLoaded = false;
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
    await this.flushPendingMessageBatches();
    await this.sessionManager?.stop();
    this.log("Bridge stopped");
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    if (this.shouldContinuePendingReply(userId, msg)) {
      await this.continuePendingReply(userId, contextToken);
      return;
    }

    await this.enqueueMessage(msg, userId, contextToken);
  }

  private async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    this.rememberQuotedMediaCandidates(userId, msg);

    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
      {
        resolveQuotedMedia: (quoteItem) => this.resolveCachedQuotedMedia(userId, quoteItem),
      },
    );

    this.queueMessageBatch(
      userId,
      contextToken,
      prompt,
      this.messageBatchDelayMsForMessage(msg),
    );
  }

  private rememberQuotedMediaCandidates(userId: string, msg: WeixinMessage): void {
    this.loadQuotedMediaCache();

    const items = msg.item_list ?? [];
    const mediaItems = items.filter((item) => hasImageMedia(item));
    if (mediaItems.length === 0) return;

    const now = Date.now();
    const cache = (this.quotedMediaCache.get(userId) ?? [])
      .filter((entry) => now - entry.cachedAt <= QUOTED_MEDIA_CACHE_TTL_MS);

    for (const item of mediaItems) {
      const keys = mediaCacheKeys(item, msg);
      const timestamps = mediaCacheTimestamps(item, msg);
      if (keys.length === 0 && timestamps.length === 0) continue;
      cache.push({
        item,
        keys: new Set(keys),
        timestamps,
        cachedAt: now,
        source: "memory",
      });
    }

    this.quotedMediaCache.set(
      userId,
      cache.slice(-QUOTED_MEDIA_CACHE_LIMIT_PER_USER),
    );
    this.saveQuotedMediaCache();
  }

  private resolveCachedQuotedMedia(
    userId: string,
    quoteItem: MessageItem,
  ): MessageItem | undefined {
    this.loadQuotedMediaCache();

    const keys = mediaCacheKeys(quoteItem);
    const timestamps = mediaCacheTimestamps(quoteItem);
    if (keys.length === 0 && timestamps.length === 0) return undefined;

    const cache = this.quotedMediaCache.get(userId) ?? [];
    const now = Date.now();
    for (let index = cache.length - 1; index >= 0; index--) {
      const entry = cache[index]!;
      if (now - entry.cachedAt > QUOTED_MEDIA_CACHE_TTL_MS) continue;
      if (keys.some((key) => entry.keys.has(key))) {
        const source = entry.source === "persisted" ? "persisted cache" : "local cache";
        this.log(`Resolved quoted media from ${source}`);
        return entry.item;
      }
    }

    if (keys.length > 0 || timestamps.length > 0) {
      this.log(
        `Quoted media cache miss: quoteKeys=${formatMediaCacheKeys(keys)}, ` +
        `quoteTimes=${formatTimestamps(timestamps)}, ` +
        `recentCache=${summarizeRecentMediaCache(cache, now)}`,
      );
    }

    return undefined;
  }

  private loadQuotedMediaCache(): void {
    if (this.quotedMediaCacheLoaded) return;
    this.quotedMediaCacheLoaded = true;

    const filePath = this.quotedMediaCachePath();
    if (!fsSync.existsSync(filePath)) return;

    try {
      const raw = fsSync.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SerializedQuotedMediaCache>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;

      const now = Date.now();
      for (const entry of parsed.entries) {
        if (!entry.userId || !entry.item || !Array.isArray(entry.keys)) continue;
        if (!entry.keys.length) continue;
        if (!Number.isFinite(entry.cachedAt) || now - entry.cachedAt > QUOTED_MEDIA_CACHE_TTL_MS) continue;

        const cache = this.quotedMediaCache.get(entry.userId) ?? [];
        cache.push({
          item: entry.item,
          keys: new Set(entry.keys),
          timestamps: Array.isArray(entry.timestamps) ? entry.timestamps.filter(Number.isFinite) : [],
          cachedAt: entry.cachedAt,
          source: "persisted",
        });
        this.quotedMediaCache.set(entry.userId, cache.slice(-QUOTED_MEDIA_CACHE_LIMIT_PER_USER));
      }
    } catch (err) {
      this.log(`Failed to load quoted media cache: ${String(err)}`);
    }
  }

  private saveQuotedMediaCache(): void {
    const now = Date.now();
    const entries: SerializedQuotedMediaCacheEntry[] = [];

    for (const [userId, cache] of this.quotedMediaCache) {
      const fresh = cache
        .filter((entry) => now - entry.cachedAt <= QUOTED_MEDIA_CACHE_TTL_MS)
        .slice(-QUOTED_MEDIA_CACHE_LIMIT_PER_USER);
      this.quotedMediaCache.set(userId, fresh);

      for (const entry of fresh) {
        if (entry.keys.size === 0) continue;
        entries.push({
          userId,
          item: entry.item,
          keys: [...entry.keys],
          timestamps: entry.timestamps,
          cachedAt: entry.cachedAt,
        });
      }
    }

    try {
      fsSync.mkdirSync(this.config.storage.dir, { recursive: true });
      fsSync.writeFileSync(
        this.quotedMediaCachePath(),
        JSON.stringify({ version: 1, entries } satisfies SerializedQuotedMediaCache),
        { encoding: "utf-8", mode: 0o600 },
      );
    } catch (err) {
      this.log(`Failed to save quoted media cache: ${String(err)}`);
    }
  }

  private quotedMediaCachePath(): string {
    return path.join(this.config.storage.dir, QUOTED_MEDIA_CACHE_FILE);
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

    const nextPending = plan.overflowTextSegments.length > 0 || plan.overflowImages.length > 0
      ? {
        textSegments: plan.overflowTextSegments,
        images: plan.overflowImages,
      }
      : null;

    if (nextPending) {
      this.log(
        `Reply for ${userId} exceeds ${plan.maxSendMessages} WeChat messages; ` +
        `sending ${plan.textSegments.length} text segments, ${plan.images.length} images, ` +
        `holding ${plan.overflowTextSegments.length} text segments, ${plan.overflowImages.length} images`,
      );
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
        throw err;
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

    if (nextPending) {
      this.pendingOverflowReplies.set(userId, nextPending);
    } else {
      this.pendingOverflowReplies.delete(userId);
    }

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async continuePendingReply(userId: string, contextToken: string): Promise<void> {
    const pending = this.pendingOverflowReplies.get(userId);
    if (!pending) return;

    this.log(`Continuing pending reply for ${userId}: ${pending.textSegments.length} text segments, ${pending.images.length} images`);
    await this.sendReplyParts(userId, contextToken, pending.textSegments, pending.images);
  }

  private queueMessageBatch(
    userId: string,
    contextToken: string,
    prompt: acp.ContentBlock[],
    delayMs: number,
  ): void {
    if (delayMs <= 0) {
      this.sessionManager!.enqueue(userId, { prompt, contextToken }).catch((err) => {
        this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
      });
      return;
    }

    const existing = this.pendingMessageBatches.get(userId);
    if (existing) {
      existing.prompt.push(...prompt);
      existing.contextToken = contextToken;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = this.createBatchTimer(userId, delayMs);
      return;
    }

    this.pendingMessageBatches.set(userId, {
      prompt: [...prompt],
      contextToken,
      timer: this.createBatchTimer(userId, delayMs),
    });
  }

  private createBatchTimer(userId: string, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.flushMessageBatch(userId).catch((err) => {
        this.log(`Failed to flush message batch for ${userId}: ${String(err)}`);
      });
    }, delayMs);
    timer.unref();
    return timer;
  }

  private async flushMessageBatch(userId: string): Promise<void> {
    const batch = this.pendingMessageBatches.get(userId);
    if (!batch) return;
    this.pendingMessageBatches.delete(userId);
    if (batch.timer) clearTimeout(batch.timer);
    await this.sessionManager!.enqueue(userId, {
      prompt: batch.prompt,
      contextToken: batch.contextToken,
    });
  }

  private async flushPendingMessageBatches(): Promise<void> {
    const userIds = [...this.pendingMessageBatches.keys()];
    for (const userId of userIds) {
      await this.flushMessageBatch(userId);
    }
  }

  private messageBatchDelayMsForMessage(msg: WeixinMessage): number {
    return hasDownloadableIncomingMedia(msg)
      ? this.mediaMessageBatchDelayMs()
      : this.textMessageBatchDelayMs();
  }

  private mediaMessageBatchDelayMs(): number {
    return normalizeBatchDelay(
      this.config.session.messageBatchDelayMs,
      DEFAULT_MESSAGE_BATCH_DELAY_MS,
    );
  }

  private textMessageBatchDelayMs(): number {
    const configured = this.config.session.textMessageBatchDelayMs;
    if (configured == null) {
      const mediaDelayMs = this.mediaMessageBatchDelayMs();
      return mediaDelayMs <= 0 ? 0 : DEFAULT_TEXT_MESSAGE_BATCH_DELAY_MS;
    }
    return normalizeBatchDelay(configured, DEFAULT_TEXT_MESSAGE_BATCH_DELAY_MS);
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

function normalizeBatchDelay(value: number | undefined, defaultValue: number): number {
  if (value == null || !Number.isFinite(value)) return defaultValue;
  return Math.max(0, Math.floor(value));
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

function hasImageMedia(item: MessageItem): boolean {
  return Boolean(
    item.image_item?.media?.encrypt_query_param ||
    item.image_item?.thumb_media?.encrypt_query_param,
  );
}

function hasDownloadableIncomingMedia(msg: WeixinMessage): boolean {
  return Boolean((msg.item_list ?? []).some((item) => (
    hasImageMedia(item) ||
    Boolean(item.video_item?.media?.encrypt_query_param) ||
    Boolean(item.file_item?.media?.encrypt_query_param) ||
    Boolean(item.voice_item?.media?.encrypt_query_param && !item.voice_item?.text)
  )));
}

type MediaCacheKeySource = {
  msg_id?: unknown;
  msgId?: unknown;
  message_id?: unknown;
  messageId?: unknown;
};

function mediaCacheKeys(...sources: Array<MediaCacheKeySource | undefined>): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    addStableMediaKey(keys, "msg", source.msg_id ?? source.msgId);
    addStableMediaKey(keys, "message", source.message_id ?? source.messageId);
  }
  return [...keys];
}

function addStableMediaKey(keys: Set<string>, prefix: string, value: unknown): void {
  if (typeof value !== "string" && typeof value !== "number") return;
  const normalized = String(value).trim();
  if (!normalized) return;
  keys.add(`${prefix}:${normalized}`);
}

function mediaCacheTimestamps(
  ...sources: Array<Pick<MessageItem, "create_time_ms" | "update_time_ms"> | undefined>
): number[] {
  const timestamps = new Set<number>();
  for (const source of sources) {
    if (!source) continue;
    for (const value of [source.create_time_ms, source.update_time_ms]) {
      const timestamp = normalizeTimestamp(value);
      if (timestamp != null) timestamps.add(timestamp);
    }
  }
  return [...timestamps];
}

function normalizeTimestamp(value: unknown): number | null {
  const timestamp = typeof value === "number" ? value
    : typeof value === "string" ? Number(value)
    : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatMediaCacheKeys(keys: string[]): string {
  if (keys.length === 0) return "none";
  return keys.map((key) => {
    if (key.startsWith("msg:")) return "msg:<present>";
    if (key.startsWith("message:")) return "message:<present>";
    return key;
  }).join(",");
}

function formatTimestamps(timestamps: number[]): string {
  return timestamps.length > 0 ? timestamps.join(",") : "none";
}

function summarizeRecentMediaCache(cache: CachedQuotedMedia[], now: number): string {
  const entries = cache
    .filter((entry) => now - entry.cachedAt <= QUOTED_MEDIA_CACHE_TTL_MS)
    .slice(-3)
    .map((entry) => `{keys=${formatMediaCacheKeys([...entry.keys])}; times=${formatTimestamps(entry.timestamps)}}`);
  return entries.length > 0 ? entries.join("|") : "empty";
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
