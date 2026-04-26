/**
 * Inbound adapter: convert WeChat messages to ACP ContentBlock[].
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";
import type { WeixinMessage, MessageItem } from "../weixin/types.js";
import { MessageItemType } from "../weixin/types.js";
import { parseAesKey, downloadAndDecrypt } from "../weixin/media.js";

interface ExtractedText {
  text: string;
  quoteText?: {
    titleLength: number;
    bodyLength: number;
  };
}

interface MediaCandidate {
  item: MessageItem;
  quoted: boolean;
}

export interface InboundPromptOptions {
  resolveQuotedMedia?: (quoteItem: MessageItem) => MessageItem | undefined;
}

/**
 * Extract text body from a WeChat message's item_list.
 */
function extractText(itemList?: MessageItem[]): ExtractedText {
  if (!itemList?.length) return { text: "" };
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return { text };
      // Build quoted context
      const parts: string[] = [];
      const title = ref.title ? String(ref.title) : "";
      const body = ref.message_item?.text_item?.text ? String(ref.message_item.text_item.text) : "";
      if (ref.title) parts.push(ref.title);
      if (body) parts.push(body);
      if (!parts.length) return { text };
      return {
        text: `[引用: ${parts.join(" | ")}]\n${text}`,
        quoteText: {
          titleLength: title.length,
          bodyLength: body.length,
        },
      };
    }
    // Voice transcription
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return { text: item.voice_item.text };
    }
  }
  return { text: "" };
}

function findMediaItems(
  itemList: MessageItem[] | undefined,
  options: InboundPromptOptions,
): MediaCandidate[] {
  if (!itemList) return [];
  const result: MediaCandidate[] = [];

  for (const item of itemList) {
    result.push(...findQuotedMediaItems(item.ref_msg, options));

    if (isDownloadableMediaItem(item)) {
      result.push({ item, quoted: false });
    }
  }

  return result;
}

function findQuotedMediaItems(refMsg: unknown, options: InboundPromptOptions): MediaCandidate[] {
  const result: MediaCandidate[] = [];
  const seen = new Set<unknown>();
  const added = new Set<MessageItem>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    const item = value as MessageItem;
    if (isDownloadableMediaItem(item) && !added.has(item)) {
      result.push({ item, quoted: true });
      added.add(item);
    } else {
      const resolved = options.resolveQuotedMedia?.(item);
      if (resolved && isDownloadableMediaItem(resolved) && !added.has(resolved)) {
        result.push({ item: resolved, quoted: true });
        added.add(resolved);
      }
    }

    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child);
    }
  };

  visit(refMsg);
  return result;
}

function hasQuoteReference(itemList?: MessageItem[]): boolean {
  return Boolean(itemList?.some((item) => item.ref_msg));
}

function isDownloadableMediaItem(item: MessageItem): boolean {
  return (
    Boolean(getImageMedia(item)?.encrypt_query_param) ||
    (item.type === MessageItemType.VIDEO && Boolean(item.video_item?.media?.encrypt_query_param)) ||
    (item.type === MessageItemType.FILE && Boolean(item.file_item?.media?.encrypt_query_param)) ||
    (item.type === MessageItemType.VOICE && Boolean(item.voice_item?.media?.encrypt_query_param) && !item.voice_item?.text)
  );
}

function getImageMedia(item: MessageItem) {
  if (item.image_item?.media?.encrypt_query_param) return item.image_item.media;
  if (item.image_item?.thumb_media?.encrypt_query_param) return item.image_item.thumb_media;
  return null;
}

/**
 * Convert a WeChat message to ACP ContentBlock[] for use in session/prompt.
 */
export async function weixinMessageToPrompt(
  msg: WeixinMessage,
  cdnBaseUrl: string,
  log: (msg: string) => void,
  options: InboundPromptOptions = {},
): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];

  // Extract text
  const extracted = extractText(msg.item_list);
  if (extracted.text) {
    blocks.push({ type: "text", text: extracted.text });
  }

  if (extracted.quoteText) {
    log(
      `Quote text attached: title=${extracted.quoteText.titleLength} chars, ` +
      `body=${extracted.quoteText.bodyLength} chars`,
    );
  }

  // Try to download and attach media
  const mediaItems = findMediaItems(msg.item_list, options);
  for (const media of mediaItems) {
    try {
      const attached = await convertMediaItem(media, cdnBaseUrl, log);
      if (attached) blocks.push(attached);
    } catch (err) {
      log(`Media download failed, skipping: ${String(err)}`);
      // Add a text note about the media
      const mediaType = media.item.image_item ? "image"
        : media.item.type === MessageItemType.VIDEO ? "video"
        : media.item.type === MessageItemType.FILE ? `file (${media.item.file_item?.file_name ?? "unknown"})`
        : media.item.type === MessageItemType.VOICE ? "voice"
        : "media";
      blocks.push({ type: "text", text: `[Received ${mediaType} - download failed]` });
    }
  }

  // Fallback: always have at least one content block
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[empty message]" });
  }

  logPromptObservability(blocks, extracted, mediaItems, msg.item_list, log);

  return blocks;
}

async function convertMediaItem(
  candidate: MediaCandidate,
  cdnBaseUrl: string,
  log: (msg: string) => void,
): Promise<acp.ContentBlock | null> {
  const item = candidate.item;
  const imageMedia = getImageMedia(item);
  if (imageMedia) {
    const media = imageMedia;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log(`Downloading ${candidate.quoted ? "quoted " : ""}image from CDN...`);
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);
    const base64 = buffer.toString("base64");

    return {
      type: "image",
      data: base64,
      mimeType: "image/jpeg",
    } as acp.ContentBlock;
  }

  if (item.type === MessageItemType.FILE && item.file_item?.media) {
    const media = item.file_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log(`Downloading file "${item.file_item.file_name}" from CDN...`);
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);

    // For text-like files, send as resource; for binary, describe it
    const fileName = item.file_item.file_name ?? "file";
    if (isTextFile(fileName)) {
      const content = buffer.toString("utf-8");
      return {
        type: "resource",
        resource: {
          uri: `file:///${fileName}`,
          mimeType: guessMimeType(fileName),
          text: content,
        },
      } as acp.ContentBlock;
    }

    return { type: "text", text: `[Received file: ${fileName}, ${buffer.length} bytes]` };
  }

  if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    // If there's a transcription, it was already handled in extractText
    // Otherwise, note we received voice
    return { type: "text", text: "[Received voice message - no transcription available]" };
  }

  if (item.type === MessageItemType.VIDEO) {
    return { type: "text", text: "[Received video message]" };
  }

  return null;
}

function logPromptObservability(
  blocks: acp.ContentBlock[],
  extracted: ExtractedText,
  mediaItems: MediaCandidate[],
  itemList: MessageItem[] | undefined,
  log: (msg: string) => void,
): void {
  const hasQuoteText = Boolean(extracted.quoteText);
  const quoteMedia = mediaItems
    .filter((media) => media.quoted)
    .map((media) => mediaTypeLabel(media.item));
  const quotePresent = hasQuoteReference(itemList);

  if (!hasQuoteText && quoteMedia.length === 0) {
    if (quotePresent) {
      log(`Quote present but no extractable text/media; ${quoteShapeSummary(itemList)}`);
    }
    return;
  }

  const textBlocks = blocks.filter((block) => block.type === "text").length;
  const imageBlocks = blocks.filter((block) => block.type === "image").length;
  const resourceBlocks = blocks.filter((block) => block.type === "resource").length;
  const quoteMediaLabel = quoteMedia.length > 0 ? quoteMedia.join(",") : "none";

  // Intentionally logs only counts and quote presence, not quoted content.
  log(
    `Inbound prompt blocks: text=${textBlocks}, images=${imageBlocks}, resources=${resourceBlocks}, ` +
    `quoteText=${hasQuoteText}, quoteMedia=${quoteMediaLabel}`,
  );
}

function mediaTypeLabel(item: MessageItem): string {
  if (item.image_item) return "image";
  if (item.type === MessageItemType.VIDEO) return "video";
  if (item.type === MessageItemType.FILE) return "file";
  if (item.type === MessageItemType.VOICE) return "voice";
  return "media";
}

function quoteShapeSummary(itemList?: MessageItem[]): string {
  const refs = itemList
    ?.filter((item) => item.ref_msg)
    .slice(0, 3)
    .map((item, index) => `ref${index + 1}{${describeQuoteShape(item.ref_msg)}}`) ?? [];
  return refs.length > 0 ? refs.join("; ") : "shape=none";
}

function describeQuoteShape(refMsg: unknown): string {
  if (!isRecord(refMsg)) return "refKeys=none";

  const parts: string[] = [`refKeys=${safeKeys(refMsg).join(",") || "none"}`];
  const messageItem = firstRecord(
    refMsg.message_item,
    refMsg.messageItem,
    refMsg.message,
    refMsg.msg,
  );

  if (!messageItem) {
    parts.push("messageItem=false");
    return parts.join("; ");
  }

  parts.push(`messageItemKeys=${safeKeys(messageItem).join(",") || "none"}`);
  if (messageItem.type != null && typeof messageItem.type !== "object") {
    parts.push(`messageItemType=${String(messageItem.type)}`);
  }
  if ("msg_id" in messageItem || "msgId" in messageItem) {
    parts.push("messageItemMsgId=true");
  }

  const imageItem = firstRecord(messageItem.image_item, messageItem.imageItem);
  if (imageItem) {
    parts.push(`imageKeys=${safeKeys(imageItem).join(",") || "none"}`);
    const media = firstRecord(imageItem.media);
    if (media) parts.push(`imageMediaKeys=${safeKeys(media).join(",") || "none"}`);
    const thumbMedia = firstRecord(imageItem.thumb_media, imageItem.thumbMedia);
    if (thumbMedia) parts.push(`thumbMediaKeys=${safeKeys(thumbMedia).join(",") || "none"}`);
  }

  const nestedLists = collectNestedListShapes(messageItem);
  if (nestedLists.length > 0) {
    parts.push(`nestedLists=${nestedLists.join("|")}`);
  }

  return parts.join("; ");
}

function collectNestedListShapes(value: unknown): string[] {
  const result: string[] = [];
  const seen = new Set<unknown>();

  const visit = (current: unknown, path: string): void => {
    if (!current || typeof current !== "object" || seen.has(current) || result.length >= 5) return;
    seen.add(current);

    if (Array.isArray(current)) {
      result.push(`${path}[${current.length}]`);
      current.slice(0, 3).forEach((child, index) => visit(child, `${path}.${index}`));
      return;
    }

    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (key === "item_list" || key === "itemList") {
        visit(child, key);
      } else if (child && typeof child === "object") {
        visit(child, `${path}.${key}`);
      }
    }
  };

  visit(value, "messageItem");
  return result;
}

function safeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => !["text", "url", "aes_key", "encrypt_query_param"].includes(key))
    .sort();
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt", "md", "json", "js", "ts", "py", "java", "c", "cpp", "h",
    "css", "html", "xml", "yaml", "yml", "toml", "ini", "cfg", "sh",
    "bash", "rs", "go", "rb", "php", "sql", "csv", "log", "env",
  ].includes(ext);
}

function guessMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json",
    js: "text/javascript", ts: "text/typescript", py: "text/x-python",
    html: "text/html", css: "text/css", xml: "text/xml",
    yaml: "text/yaml", yml: "text/yaml", csv: "text/csv",
  };
  return map[ext] ?? "text/plain";
}
