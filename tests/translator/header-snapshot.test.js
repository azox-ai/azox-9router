import { describe, it, expect } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { normalizeDynamicHeaders } from "./header-snapshot.js";

const context = { packageVersion: "9.8.7", nodeVersion: "v24.1.0" };
const cline = {
  "User-Agent": "9Router/9.8.7",
  "X-CLIENT-VERSION": "9.8.7",
  "X-CORE-VERSION": "9.8.7",
  "X-PLATFORM-VERSION": "v24.1.0",
  "X-Title": "Cline",
};
const ids = {
  "X-Request-ID": "11111111-1111-4111-8111-111111111111",
  "X-Conversation-ID": "22222222-2222-4222-8222-222222222222",
  "X-Conversation-Request-ID": "11111111-1111-4111-8111-111111111111",
  "X-Conversation-Message-ID": "11111111-1111-4111-8111-111111111111",
};

// Catch version drift without masking missing/wrong values or unrelated fields.
describe("header snapshot version guards", () => {
  for (const provider of ["cline", "clinepass"]) {
    it(`${provider} normalizes valid package and runtime relations without mutation`, () => {
      const input = Object.freeze({ ...cline, "x-custom-version": "9.8.7" });
      expect(normalizeDynamicHeaders(provider, input, context)).toEqual({
        "User-Agent": "9Router/<PACKAGE_VERSION>",
        "X-CLIENT-VERSION": "<PACKAGE_VERSION>",
        "X-CORE-VERSION": "<PACKAGE_VERSION>",
        "X-PLATFORM-VERSION": "<NODE_VERSION>",
        "X-Title": "Cline",
        "x-custom-version": "9.8.7",
      });
      expect(input["User-Agent"]).toBe("9Router/9.8.7");
    });
    for (const key of Object.keys(cline).filter((key) => key !== "X-Title")) {
      for (const fault of ["missing", "number", "wrong relation"]) {
        it(`${provider} rejects ${key}: ${fault}`, () => {
          const input = { ...cline };
          if (fault === "missing") delete input[key];
          else input[key] = fault === "number" ? 7 : "wrong";
          expect(() => normalizeDynamicHeaders(provider, input, context)).toThrow(/Invalid dynamic header:/);
        });
      }
    }
  }
  it("kimi normalizes only its package version", () => {
    expect(normalizeDynamicHeaders("kimi", { "X-Msh-Version": "9.8.7", other: "9.8.7" }, context))
      .toEqual({ "X-Msh-Version": "<PACKAGE_VERSION>", other: "9.8.7" });
  });
  for (const value of [undefined, 7, "wrong"]) {
    it(`kimi rejects invalid package version ${typeof value}`, () => {
      const headers = value === undefined ? {} : { "X-Msh-Version": value };
      expect(() => normalizeDynamicHeaders("kimi", headers, context)).toThrow(/Invalid dynamic header:/);
    });
  }
  it("accepts a different valid package and runtime version", () => {
    expect(normalizeDynamicHeaders("cline", {
      "User-Agent": "9Router/10.2.3-azox.2", "X-CLIENT-VERSION": "10.2.3-azox.2",
      "X-CORE-VERSION": "10.2.3-azox.2", "X-PLATFORM-VERSION": "v26.0.1",
    }, { packageVersion: "10.2.3-azox.2", nodeVersion: "v26.0.1" }))
      .toEqual({ "User-Agent": "9Router/<PACKAGE_VERSION>", "X-CLIENT-VERSION": "<PACKAGE_VERSION>",
        "X-CORE-VERSION": "<PACKAGE_VERSION>", "X-PLATFORM-VERSION": "<NODE_VERSION>" });
  });
});

// Catch missing IDs, non-v4 values, correlation loss and conversation reuse.
describe("header snapshot UUID guards", () => {
  for (const provider of ["codebuddy-cn", "codebuddy-intl"]) {
    it(`${provider} normalizes correlated UUIDv4 values only`, () => {
      const input = Object.freeze({ ...ids, "X-Other-ID": ids["X-Request-ID"] });
      expect(normalizeDynamicHeaders(provider, input)).toEqual({
        "X-Request-ID": "<REQUEST_UUID>", "X-Conversation-ID": "<CONVERSATION_UUID>",
        "X-Conversation-Request-ID": "<REQUEST_UUID>", "X-Conversation-Message-ID": "<REQUEST_UUID>",
        "X-Other-ID": "11111111-1111-4111-8111-111111111111",
      });
    });
    for (const key of Object.keys(ids)) {
      for (const fault of ["missing", "number", "malformed", "v1", "variant"]) {
        it(`${provider} rejects ${key}: ${fault}`, () => {
          const input = { ...ids };
          if (fault === "missing") delete input[key];
          else input[key] = { number: 7, malformed: "not-a-uuid", v1: "11111111-1111-1111-8111-111111111111", variant: "11111111-1111-4111-7111-111111111111" }[fault];
          expect(() => normalizeDynamicHeaders(provider, input)).toThrow(/Invalid dynamic header:/);
        });
      }
    }
    for (const key of ["X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
      it(`${provider} rejects broken ${key} correlation`, () => {
        expect(() => normalizeDynamicHeaders(provider, { ...ids, [key]: ids["X-Conversation-ID"] }))
          .toThrow(/Invalid dynamic header:/);
      });
    }
    it(`${provider} rejects conversation/request collision`, () => {
      expect(() => normalizeDynamicHeaders(provider, { ...ids, "X-Conversation-ID": ids["X-Request-ID"] }))
        .toThrow(/Invalid dynamic header:/);
    });
  }
});

it("does not normalize unrelated providers", () => {
  const input = { ...cline, ...ids, "X-Msh-Version": "9.8.7" };
  expect(normalizeDynamicHeaders("openai", input, context)).toEqual(input);
});
for (const provider of ["cline", "clinepass", "kimi", "codebuddy-cn", "codebuddy-intl"]) {
  it(`${provider} rejects builder failure strings rather than snapshotting them`, () => {
    expect(() => normalizeDynamicHeaders(provider, "THROW: builder failed")).toThrow(/Invalid dynamic header:/);
  });
  for (const stream of [true, false]) {
    for (const credentials of [{ apiKey: "dummy-key" }, { accessToken: "dummy-access" }]) {
      it(`${provider} validates real executor ${stream}/${Object.keys(credentials)[0]}`, () => {
        const headers = new DefaultExecutor(provider).buildHeaders(credentials, stream);
        const result = normalizeDynamicHeaders(provider, headers);
        expect(result).not.toBe(headers);
        expect(result["Content-Type"]).toBe("application/json");
        if (provider.startsWith("codebuddy")) expect(result["X-Request-ID"]).toBe("<REQUEST_UUID>");
        else if (provider === "kimi") expect(result["X-Msh-Version"]).toBe("<PACKAGE_VERSION>");
        else expect(result["X-CLIENT-VERSION"]).toBe("<PACKAGE_VERSION>");
      });
    }
  }
}
