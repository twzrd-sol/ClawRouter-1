import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The operator's privacy page says prompt and reply text is never written to logs.
// The proxy's console output goes to the service journal, so no console call in
// proxy.ts may interpolate prompt text or the accumulated reply.
const src = readFileSync(new URL("./proxy.ts", import.meta.url), "utf8");
const consoleCalls = [...src.matchAll(/console\.(?:log|warn|error|info|debug)\(([\s\S]*?)\);/g)].map((m) => m[1]);

describe("proxy console output carries no prompt or reply text", () => {
  it("finds the proxy's console calls", () => {
    expect(consoleCalls.length).toBeGreaterThan(20);
  });
  it.each([/imagePrompt/, /img2imgPrompt/, /accumulatedContent\.slice/, /JSON\.stringify\(firstChar\)/])("no console call uses %s", (re) => {
    expect(consoleCalls.filter((c) => re.test(c))).toEqual([]);
  });
});
