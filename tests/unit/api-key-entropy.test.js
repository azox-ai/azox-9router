import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateApiKeyWithMachine, parseApiKey } from "../../src/shared/utils/apiKey.js";

afterEach(() => vi.restoreAllMocks());

describe("machine API key identifiers", () => {
  it("does not repeat keys when Math.random repeats", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const first = generateApiKeyWithMachine("0123456789abcdef");
    const second = generateApiKeyWithMachine("0123456789abcdef");
    expect(first.key).not.toBe(second.key);
    expect(first.keyId).toMatch(/^[a-f0-9]{32}$/);
    expect(parseApiKey(first.key)).toEqual({
      machineId: "0123456789abcdef", keyId: first.keyId, isNewFormat: true,
    });
  });

  it.each([[42], [true], [{}], [["sk-array"]], [Symbol("not-a-key")]])("rejects non-string API key %s without throwing", (value) => {
    expect(parseApiKey(value)).toBeNull();
  });

  it("accepts older six-character machine keys and rejects altered checksums", () => {
    const secret = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
    const crc = crypto.createHmac("sha256", secret).update("0123456789abcdefabc123").digest("hex").slice(0, 8);
    expect(parseApiKey(`sk-0123456789abcdef-abc123-${crc}`)).toEqual({
      machineId: "0123456789abcdef", keyId: "abc123", isNewFormat: true,
    });
    expect(parseApiKey(`sk-0123456789abcdef-abc123-${crc}0`)).toBeNull();
    expect(parseApiKey("sk-legacy12")).toEqual({ machineId: null, keyId: "legacy12", isNewFormat: false });
  });
});
