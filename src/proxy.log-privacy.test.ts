import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * The service log must never carry the text of a prompt or of a reply.
 *
 * Three statements used to print an excerpt: the /imagegen and /img2img chat
 * commands logged the first 80 characters of the prompt, and the
 * degenerate-output diagnostic logged the first 40 characters of the reply
 * plus the repeated character. None of them prints text any more. These
 * tests drive the three paths with marked text and read everything the proxy
 * wrote to the console.
 */
const PROMPT_MARK = "zebra-quartz-prompt-7731";
const REPLY_MARK = "ostrich-basalt-reply-4402";
/** At least 60 of the last 80 characters are one punctuation mark: the diagnostic's trigger. */
const DEGENERATE_REPLY = `${REPLY_MARK} ${"~".repeat(120)}`;

describe("service log carries no prompt or reply text", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let scratch: string;
  let sourceImage: string;
  const logged: string[] = [];
  const priorStore = process.env.BLOCKRUN_RESPONSE_STORE;

  const chat = async (content: string) => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content }],
        max_tokens: 64,
      }),
    });
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { status: res.status, text: body.choices?.[0]?.message?.content ?? "" };
  };

  /** Wait for a log line: the degenerate diagnostic is written after the response is sent. */
  const lineWith = async (needle: string): Promise<string | undefined> => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const hit = logged.find((line) => line.includes(needle));
      if (hit || Date.now() > deadline) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    // This file is about the console. Keep the reply out of the on-disk response store too.
    process.env.BLOCKRUN_RESPONSE_STORE = "off";

    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }

    scratch = mkdtempSync(join(tmpdir(), "clawrouter-log-privacy-"));
    sourceImage = join(scratch, "source.png");
    // Enough for the PNG signature check; the upstream stub never decodes it.
    writeFileSync(
      sourceImage,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]),
    );

    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.method === "POST" && req.url === "/v1/images/generations") {
          return json(200, { created: 1, data: [{ url: "https://images.invalid/generated.png" }] });
        }
        if (req.method === "POST" && req.url === "/v1/images/image2image") {
          return json(200, { created: 1, data: [{ url: "https://images.invalid/edited.png" }] });
        }
        if (req.method === "POST" && req.url === "/v1/chat/completions") {
          return json(200, {
            id: "chatcmpl-log-privacy",
            object: "chat.completion",
            created: 1,
            model: "openai/gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: DEGENERATE_REPLY },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 40, total_tokens: 45 },
          });
        }
        return json(404, { error: "unexpected path" });
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      skipBalanceCheck: true,
    });
  }, 15_000);

  beforeEach(() => {
    logged.length = 0;
  });

  afterAll(async () => {
    await proxy?.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
    if (priorStore === undefined) delete process.env.BLOCKRUN_RESPONSE_STORE;
    else process.env.BLOCKRUN_RESPONSE_STORE = priorStore;
  });

  it("logs no text from an /imagegen prompt", async () => {
    const prompt = `${PROMPT_MARK} a lighthouse at dusk`;
    const reply = await chat(`/imagegen ${prompt}`);

    expect(reply.status).toBe(200);
    expect(reply.text).toContain("https://images.invalid/generated.png");
    const line = await lineWith("/imagegen command →");
    expect(line).toBeDefined();
    expect(logged.join("\n")).not.toContain(PROMPT_MARK);
  }, 15_000);

  it("logs no text from an /img2img prompt", async () => {
    const prompt = `${PROMPT_MARK} make the sky green`;
    const reply = await chat(`/img2img --image ${sourceImage} ${prompt}`);

    expect(reply.status).toBe(200);
    expect(reply.text).toContain("https://images.invalid/edited.png");
    const line = await lineWith("/img2img →");
    expect(line).toBeDefined();
    expect(logged.join("\n")).not.toContain(PROMPT_MARK);
  }, 15_000);

  it("reports a degenerate reply by its counts, not its text", async () => {
    const reply = await chat("say something");

    // The caller still gets the reply; only the log changed.
    expect(reply.status).toBe(200);
    expect(reply.text).toBe(DEGENERATE_REPLY);
    const line = await lineWith("Degenerate output detected");
    expect(line).toContain(`len=${DEGENERATE_REPLY.length}`);
    expect(line).toContain("tail_repeats=80/80");
    expect(line).not.toContain("head=");
    expect(line).not.toContain("~");
    expect(logged.join("\n")).not.toContain(REPLY_MARK);
  }, 15_000);
});
