/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import { getUploadUrl, sendMessage } from "./api.js";
import { aesEcbPaddedSize, uploadToCdn } from "./media.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";

export interface WeixinSendOpts {
  baseUrl: string;
  token?: string;
  contextToken?: string;
  debug?: WeixinSendDebug;
}

export interface WeixinImageSendOpts extends WeixinSendOpts {
  cdnBaseUrl: string;
}

export interface WeixinSendDebug {
  index?: number;
  total?: number;
  label?: string;
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts: WeixinSendOpts,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  try {
    await sendMessage({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: opts.contextToken,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        },
      },
    });
  } catch (err) {
    throw withSendContext(err, {
      kind: "text",
      clientId,
      contextToken: opts.contextToken,
      to,
      textLength: text.length,
      debug: opts.debug,
    });
  }
  return clientId;
}

export async function sendImageMessage(
  to: string,
  image: { buffer: Buffer; mimeType?: string; name?: string },
  opts: WeixinImageSendOpts,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  const rawsize = image.buffer.length;
  const rawfilemd5 = crypto.createHash("md5").update(image.buffer).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);

  try {
    const uploadUrlResp = await getUploadUrl({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: {
        filekey,
        media_type: UploadMediaType.IMAGE,
        to_user_id: to,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
      },
    });

    const uploadParam = uploadUrlResp.upload_param;
    const uploadFullUrl = uploadUrlResp.upload_full_url;
    if (!uploadParam && !uploadFullUrl) {
      throw new Error("getUploadUrl returned no upload URL");
    }

    const downloadParam = await uploadToCdn({
      buffer: image.buffer,
      uploadParam,
      uploadFullUrl,
      aesKey,
      filekey,
      cdnBaseUrl: opts.cdnBaseUrl,
    });

    await sendMessage({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: opts.contextToken,
          item_list: [{
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: filesize,
            },
          }],
        },
      },
    });
  } catch (err) {
    throw withSendContext(err, {
      kind: "image",
      clientId,
      contextToken: opts.contextToken,
      to,
      rawsize,
      filesize,
      rawfilemd5,
      filekey,
      label: image.name,
      debug: opts.debug,
    });
  }
  return clientId;
}

function withSendContext(err: unknown, context: {
  kind: "text" | "image";
  clientId: string;
  contextToken?: string;
  to: string;
  textLength?: number;
  rawsize?: number;
  filesize?: number;
  rawfilemd5?: string;
  filekey?: string;
  label?: string;
  debug?: WeixinSendDebug;
}): Error {
  const parts = [
    `kind=${context.kind}`,
    `clientId=${context.clientId}`,
    `toHash=${shortHash(context.to)}`,
    `contextHash=${shortHash(context.contextToken)}`,
  ];
  if (context.debug?.index != null && context.debug.total != null) {
    parts.push(`index=${context.debug.index}/${context.debug.total}`);
  }
  if (context.debug?.label) parts.push(`debugLabel=${context.debug.label}`);
  if (context.label) parts.push(`label=${context.label}`);
  if (context.textLength != null) parts.push(`textLength=${context.textLength}`);
  if (context.rawsize != null) parts.push(`rawsize=${context.rawsize}`);
  if (context.filesize != null) parts.push(`filesize=${context.filesize}`);
  if (context.rawfilemd5) parts.push(`rawfilemd5=${context.rawfilemd5}`);
  if (context.filekey) parts.push(`filekey=${context.filekey}`);

  const wrapped = new Error(`send ${context.kind} failed (${parts.join(" ")}): ${String(err)}`);
  wrapped.cause = err;
  return wrapped;
}

function shortHash(value: string | undefined): string {
  if (!value) return "none";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Split text into segments of max length, respecting line breaks where possible.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}
