import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  exchangeTokens: vi.fn(),
}));

vi.mock("@/lib/oauth/providers", () => ({
  exchangeTokens: mocks.exchangeTokens,
}));
vi.mock("@/models", () => ({
  createProviderConnection: mocks.createConnection,
}));

const proxy = await import("../../src/lib/oauth/utils/server.js");

function requestCallback(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, ...options }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
  });
}

function requestCallbackWithBody(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, ...options }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
  });
}

// AZO-1214: normal-login cases preserved from contributor-proxy-atomic.
describe("normal OAuth proxy contracts", () => {
  beforeEach(() => {
    mocks.createConnection.mockReset();
    mocks.exchangeTokens.mockReset().mockResolvedValue({
      accessToken: "proxy-access-token",
      refreshToken: "proxy-refresh-token",
      email: "proxy@example.test",
    });
    proxy.clearTraeSession();
  });

  afterEach(() => {
    proxy.stopTraeProxy();
    proxy.stopWindsurfProxy();
    proxy.clearTraeSession();
    proxy.clearWindsurfSession();
  });

  it("does not expose raw provider failures in callback HTML or poll state", async () => {
    const reflectedSecret = "refreshToken=secret-value upstream echoed credentials";
    mocks.exchangeTokens.mockRejectedValueOnce(new Error(reflectedSecret));
    const started = await proxy.startTraeProxy();
    expect(proxy.registerTraeSession({ state: "proxy-error-state" })).toBe(true);

    const callback = await requestCallbackWithBody(
      `${started.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=proxy-error-state`,
    );

    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("OAuth authentication failed");
    expect(callback.body).not.toContain(reflectedSecret);
    expect(proxy.getTraeSessionStatus("proxy-error-state")).toMatchObject({
      status: "error",
      error: "OAuth authentication failed",
    });
  });

  it.each([
    {
      provider: "Trae",
      start: () => proxy.startTraeProxy(),
      register: (state) => proxy.registerTraeSession({ state }),
      status: (state) => proxy.getTraeSessionStatus(state),
      callbackQuery: (state) => `refreshToken=fixture&loginHost=example.test&state=${state}`,
    },
    {
      provider: "Windsurf",
      start: () => proxy.startWindsurfProxy(),
      register: (state) => proxy.registerWindsurfSession({ state }),
      status: (state) => proxy.getWindsurfSessionStatus(state),
      callbackQuery: (state) => `access_token=fixture&state=${state}`,
    },
  ])("keeps the $provider session pending after a wrong-state callback", async ({
    start,
    register,
    status,
    callbackQuery,
  }) => {
    mocks.createConnection.mockResolvedValueOnce({
      id: "correct-state-connection",
      email: "correct@example.test",
    });
    const started = await start();
    expect(started.success).toBe(true);
    expect(register("correct-state")).toBe(true);

    await expect(requestCallback(
      `${started.callbackUrl}?${callbackQuery("wrong-state")}`,
    )).resolves.toBe(409);
    expect(status("correct-state")).toMatchObject({ status: "pending" });

    await expect(requestCallback(
      `${started.callbackUrl}?${callbackQuery("correct-state")}`,
    )).resolves.toBe(200);
    expect(status("correct-state")).toMatchObject({ status: "done" });
    expect(mocks.exchangeTokens).toHaveBeenCalledOnce();
    expect(mocks.createConnection).toHaveBeenCalledOnce();
  });

  it("rechecks a normal persistence guard after a delayed DB boundary", async () => {
    let releasePersistence;
    let markPersistenceStarted;
    const persistenceStarted = new Promise((resolve) => { markPersistenceStarted = resolve; });
    const dbWrite = vi.fn();
    mocks.createConnection.mockImplementationOnce(async (_connection, options) => {
      markPersistenceStarted();
      await new Promise((resolve) => { releasePersistence = resolve; });
      if (options?.shouldCommit && !options.shouldCommit()) return null;
      dbWrite();
      return { id: "stale-normal-write", email: "stale@example.test" };
    });

    const first = await proxy.startTraeProxy();
    expect(first.success).toBe(true);
    expect(proxy.registerTraeSession({ state: "normal-old-state" })).toBe(true);
    const oldCallback = requestCallback(
      `${first.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=normal-old-state`,
    );
    await persistenceStarted;

    expect(proxy.stopTraeProxy()).toBe(true);
    const replacement = await proxy.startTraeProxy();
    expect(replacement.success).toBe(true);
    expect(proxy.registerTraeSession({ state: "normal-new-state" })).toBe(true);

    releasePersistence();
    await expect(oldCallback).resolves.toBe(200);

    expect(dbWrite).not.toHaveBeenCalled();
    expect(proxy.getTraeSessionStatus("normal-new-state")).toMatchObject({ status: "pending" });
    await expect(proxy.startTraeProxy()).resolves.toMatchObject({
      success: true,
      callbackUrl: replacement.callbackUrl,
    });
  });

});
