/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), handles permission requests, and provides filesystem access
 * for the agent.
 */

import fs from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export interface AgentImage {
  data?: string;
  uri?: string;
  name?: string;
  mimeType: string;
}

export interface AgentReply {
  text: string;
  images: AgentImage[];
}

export interface WeChatAcpClientOpts {
  rootDir?: string;
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  log: (msg: string) => void;
  showThoughts: boolean;
}

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private images: AgentImage[] = [];
  private imageKeys = new Set<string>();
  private opts: WeChatAcpClientOpts;
  private rootDir: string;
  private rootRealPath: Promise<string> | null = null;
  private lastTypingAt = 0;
  private static readonly TYPING_INTERVAL_MS = 5_000;

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
    this.rootDir = path.resolve(opts.rootDir ?? process.cwd());
  }

  updateCallbacks(callbacks: { sendTyping: () => Promise<void>; onThoughtFlush: (text: string) => Promise<void> }): void {
    this.opts = {
      ...this.opts,
      sendTyping: callbacks.sendTyping,
      onThoughtFlush: callbacks.onThoughtFlush,
    };
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const title = params.toolCall?.title ?? "unknown";
    // Auto-allow: find first "allow" option
    const allowOpt = findPermissionOption(params.options, ["allow_once", "allow_always"]);
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${title} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts();
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
        } else {
          this.captureContentBlock(update.content);
        }
        // Throttle typing indicators
        await this.maybeSendTyping();
        break;

      case "tool_call":
        await this.maybeFlushThoughts();
        if (update.content) {
          for (const c of update.content) this.captureToolCallContent(c);
        }
        this.opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          const text = update.content.text;
          this.opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        if (update.content) {
          for (const c of update.content) {
            this.captureToolCallContent(c);
            if (update.status === "completed" && c.type === "diff") {
              const diff = c as acp.Diff;
              const header = `--- ${diff.path}`;
              const lines: string[] = [header];
              if (diff.oldText != null) {
                for (const l of diff.oldText.split("\n")) lines.push(`- ${l}`);
              }
              if (diff.newText != null) {
                for (const l of diff.newText.split("\n")) lines.push(`+ ${l}`);
              }
              this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
            }
          }
        }
        if (update.status) {
          this.opts.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        break;

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          this.opts.log(`[plan]\n${items}`);
        }
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const filePath = await this.resolveReadablePath(params.path);
      const content = await fs.promises.readFile(filePath, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      const filePath = await this.resolveWritablePath(params.path);
      await fs.promises.writeFile(filePath, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<AgentReply> {
    await this.maybeFlushThoughts();
    const text = this.chunks.join("");
    const images = this.images;
    this.chunks = [];
    this.images = [];
    this.imageKeys.clear();
    this.lastTypingAt = 0;
    return { text, images };
  }

  private async maybeFlushThoughts(): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (thoughtText.trim()) {
      try {
        await this.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`);
      } catch {
        // best effort
      }
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await this.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }

  private captureToolCallContent(content: acp.ToolCallContent): void {
    if (content.type !== "content") return;
    this.captureContentBlock(content.content);
  }

  private captureContentBlock(block: acp.ContentBlock): void {
    if (block.type === "image") {
      this.addImage({
        data: block.data,
        uri: block.uri ?? undefined,
        mimeType: block.mimeType,
      });
      return;
    }

    if (block.type === "resource_link") {
      const mimeType = imageMimeType(block.mimeType ?? undefined, block.uri);
      if (!mimeType) return;
      this.addImage({
        uri: block.uri,
        name: block.name,
        mimeType,
      });
      return;
    }

    if (block.type === "resource") {
      const resource = block.resource;
      const mimeType = imageMimeType(resource.mimeType ?? undefined, resource.uri);
      if (!mimeType) return;
      this.addImage({
        data: "blob" in resource ? resource.blob : undefined,
        uri: resource.uri,
        mimeType,
      });
    }
  }

  private addImage(image: AgentImage): void {
    if (!image.mimeType.startsWith("image/")) return;
    if (!image.data && !image.uri) return;

    const key = image.uri
      ? `uri:${image.uri}`
      : `data:${image.mimeType}:${image.data?.length ?? 0}:${image.data?.slice(0, 64) ?? ""}`;
    if (this.imageKeys.has(key)) return;

    this.imageKeys.add(key);
    this.images.push(image);
    const label = image.name ?? image.uri ?? image.mimeType;
    this.opts.log(`[image] queued ${label.length > 100 ? label.substring(0, 100) + "..." : label}`);
  }

  private async resolveReadablePath(requestPath: string): Promise<string> {
    const targetPath = path.resolve(this.rootDir, requestPath);
    const realPath = await fs.promises.realpath(targetPath);
    await this.assertWithinRoot(realPath);
    return realPath;
  }

  private async resolveWritablePath(requestPath: string): Promise<string> {
    const targetPath = path.resolve(this.rootDir, requestPath);

    try {
      const existingRealPath = await fs.promises.realpath(targetPath);
      await this.assertWithinRoot(existingRealPath);
      return existingRealPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const parentRealPath = await fs.promises.realpath(path.dirname(targetPath));
    await this.assertWithinRoot(parentRealPath);
    return targetPath;
  }

  private async assertWithinRoot(realPath: string): Promise<void> {
    const root = await this.getRootRealPath();
    const relative = path.relative(root, realPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return;
    }
    throw new Error(`Path is outside allowed root ${root}: ${realPath}`);
  }

  private getRootRealPath(): Promise<string> {
    this.rootRealPath ??= fs.promises.realpath(this.rootDir);
    return this.rootRealPath;
  }
}

function findPermissionOption(
  options: acp.PermissionOption[],
  kinds: acp.PermissionOptionKind[],
): acp.PermissionOption | undefined {
  return options.find((option) => kinds.includes(option.kind));
}

function imageMimeType(mimeType: string | undefined, uri: string): string | null {
  if (mimeType?.startsWith("image/")) return mimeType;
  const dataUriMime = /^data:(image\/[^;,]+)[;,]/i.exec(uri.trim())?.[1];
  if (dataUriMime) return dataUriMime;

  const path = uri.startsWith("data:")
    ? uri.substring(5, uri.indexOf(";") > 0 ? uri.indexOf(";") : undefined)
    : uri.split(/[?#]/)[0] ?? uri;
  const ext = path.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return null;
  }
}
