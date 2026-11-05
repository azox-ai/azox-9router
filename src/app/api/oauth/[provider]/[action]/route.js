import crypto from "crypto";
import { NextResponse } from "next/server";
import {
  getProvider,
  generateAuthData,
  exchangeTokens,
  requestDeviceCode,
  pollForToken
} from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";
import { getProviderConnections } from "@/lib/localDb";
import { requestLease, requestStatus, resolveLeaseEndpoint, resolveMcodeDataDir, AuthLeaseError } from "open-sse/services/minimaxCodeLease.js";
import { readDesktopPassToken } from "open-sse/shared/mimoAccount.js";
import { readRequestJson } from "open-sse/utils/requestBody.js";

function oauthErrorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
    ? error.status : 500;
}

const PUBLIC_VALIDATION_ERRORS = new Set([
  "GitLab base URL must be a valid HTTP or HTTPS URL",
  "GitLab base URL must use HTTP or HTTPS",
  "GitLab base URL cannot contain credentials, query parameters, or fragments",
  "Missing xAI authorization code",
  "xAI OAuth session is missing or already being completed; restart the login flow",
  "OAuth session is no longer active",
]);

function oauthPublicErrorMessage(error) {
  return oauthErrorStatus(error) < 500 && PUBLIC_VALIDATION_ERRORS.has(error?.message)
    ? error.message : "OAuth request failed";
}

const PUBLIC_POLL_FAILURES = Object.freeze({
  authorization_pending: "Authorization pending",
  slow_down: "Please slow down token polling",
  access_denied: "Authorization was denied",
  expired_token: "Authorization expired. Please restart the login flow.",
  exchange_failed: "OAuth token exchange failed",
});

function publicPollFailure(result) {
  const code = typeof result?.error === "string" ? result.error : "";
  const error = Object.hasOwn(PUBLIC_POLL_FAILURES, code) ? code : "oauth_poll_failed";
  return {
    error,
    errorDescription: PUBLIC_POLL_FAILURES[error] || "OAuth token polling failed",
    pending: result?.fatal !== true && (error === "authorization_pending" || error === "slow_down"),
    ...(result?.fatal === true ? { fatal: true } : {}),
  };
}

const START_PROXY_QUERY_PRIVATE_KEYS = [
  "state", "code_verifier", "codeVerifier", "redirect_uri", "redirectUri",
  "access_token", "accessToken", "refresh_token", "refreshToken", "token",
  "client_secret", "clientSecret",
];
const MAX_OAUTH_REQUEST_BODY_BYTES = 1024 * 1024;

async function startFixedCallbackProxy(provider, payload = {}) {
  if (!["codex", "xai"].includes(provider)) {
    return NextResponse.json({ error: "Proxy only supported for codex/xai" }, { status: 400 });
  }
  const appPort = Number(payload.appPort ?? payload.app_port);
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
    return NextResponse.json({ error: "Invalid app_port" }, { status: 400 });
  }
  const { state, codeVerifier, redirectUri } = payload;
  if ([state, codeVerifier, redirectUri].some(Boolean)
      && ![state, codeVerifier, redirectUri].every((value) => typeof value === "string" && value.length > 0)) {
    return NextResponse.json({ error: "Missing OAuth session fields" }, { status: 400 });
  }
  const result = provider === "xai" ? await startXaiProxy(appPort) : await startCodexProxy(appPort);
  const serverSide = !!(result.success && state && (provider === "xai"
    ? registerXaiSession({ state, codeVerifier, redirectUri })
    : registerCodexSession({ state, codeVerifier, redirectUri })));
  return NextResponse.json({ ...result, serverSide });
}
import {
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startXaiProxy,
  stopXaiProxy,
  registerXaiSession,
  getXaiSessionStatus,
  claimXaiSession,
  isXaiSessionCurrent,
  clearXaiSession,
  startTraeProxy,
  stopTraeProxy,
  registerTraeSession,
  getTraeSessionStatus,
  clearTraeSession,
  startWindsurfProxy,
  stopWindsurfProxy,
  registerWindsurfSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  startZedProxy,
  stopZedProxy,
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
} from "@/lib/oauth/utils/server";
import { detectIdeInstalled } from "@/lib/oauth/utils/ideDetect";
import { ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";

async function completeXaiManualCode(code, state) {
  if (!code) throw Object.assign(new Error("Missing xAI authorization code"), { status: 400 });
  const session = claimXaiSession(state);
  if (!session) {
    throw Object.assign(new Error("xAI OAuth session is missing or already being completed; restart the login flow"), { status: 409 });
  }

  try {
    const tokenData = await exchangeTokens(
      "xai",
      code,
      session.redirectUri,
      session.codeVerifier,
      state
    );
    const shouldCommit = () => isXaiSessionCurrent(state, session);
    if (!shouldCommit()) throw Object.assign(new Error("OAuth session is no longer active"), { status: 409 });
    const connection = await createProviderConnection({
      provider: "xai",
      authType: "oauth",
      ...tokenData,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    }, { shouldCommit });
    if (!connection || !shouldCommit()) throw Object.assign(new Error("OAuth session is no longer active"), { status: 409 });
    clearXaiSession(state, session);
    stopXaiProxy(undefined, session._proxyGeneration);
    return {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    };
  } catch (err) {
    clearXaiSession(state, session);
    stopXaiProxy(undefined, session._proxyGeneration);
    throw err;
  }
}

/**
 * Dynamic OAuth API Route
 * Handles: authorize, exchange, device-code, poll
 */

// GET /api/oauth/[provider]/authorize - Generate auth URL
// GET /api/oauth/[provider]/device-code - Request device code (for device_code flow)
export async function GET(request, { params }) {
  try {
    const { provider, action } = await params;
    const { searchParams } = new URL(request.url);

    if (action === "authorize") {
      if (searchParams.has("clientSecret") || searchParams.has("client_secret")) {
        return NextResponse.json({ error: "OAuth client secrets are not accepted in authorize URLs" }, { status: 400 });
      }
      // Xiaomi Desktop: custom ECDH flow — generate keypair, start proxy, return authorize URL
      if (provider === "xiaomi-mimo") {
        const { generateKeyPair, buildAuthorizeUrl, getKeyName } = await import("@/lib/oauth/providers/xiaomi-mimo");
        const { publicKey, privateKeyDer } = generateKeyPair();
        const state = searchParams.get("state") || crypto.randomUUID();

        // Start the callback proxy (or reuse if already running)
        const proxyResult = await startXiaomiMimoProxy();
        if (!proxyResult.success) {
          return NextResponse.json({ error: `Failed to start callback server: ${proxyResult.reason}` }, { status: 500 });
        }

        // Register the session with the private key for decryption
        registerXiaomiMimoSession({ state, privateKeyDer });

        const redirectUri = proxyResult.callbackUrl;
        const authorizeUrl = buildAuthorizeUrl(publicKey, redirectUri, getKeyName());

        return NextResponse.json({
          state,
          authorizeUrl,
          redirectUri,
          port: proxyResult.port,
        });
      }

      const redirectUri = searchParams.get("redirect_uri") || "http://localhost:8080/callback";
      // Collect public provider-specific metadata (e.g. GitLab baseUrl and clientId).
      const reservedParams = new Set(["redirect_uri"]);
      const meta = {};
      searchParams.forEach((value, key) => { if (!reservedParams.has(key)) meta[key] = value; });
      // Zed: derive native_app_port from the local callback URL so the RSA keypair
      // is bound to the port the proxy is actually listening on.
      if (provider === "zed") {
        try { const p = new URL(redirectUri).port; if (p) meta.nativeAppPort = p; } catch { /* ignore */ }
      }
      const authData = await generateAuthData(provider, redirectUri, Object.keys(meta).length ? meta : undefined);
      return NextResponse.json(authData);
    }

    if (action === "start-proxy") {
      if (START_PROXY_QUERY_PRIVATE_KEYS.some((key) => searchParams.has(key))) {
        return NextResponse.json({ error: "OAuth state, verifier, and tokens are not accepted in start-proxy URLs" }, { status: 400 });
      }
      // Trae/Windsurf/Zed use a dynamic-port local callback server (singleton session,
      // state is registered separately via /register-session after /authorize).
      if (provider === "trae") {
        const result = await startTraeProxy();
        return NextResponse.json(result);
      }
      if (provider === "windsurf") {
        const result = await startWindsurfProxy();
        return NextResponse.json(result);
      }
      if (provider === "zed") {
        // Prefer ZED_HOSTED_CONFIG.defaultNativeAppPort (58443) so the browser redirect
        // matches what Zed expects; falls back to a random port if it's busy.
        const result = await startZedProxy(searchParams.get("native_app_port") || ZED_HOSTED_CONFIG.defaultNativeAppPort);
        return NextResponse.json(result);
      }
      if (provider === "xiaomi-mimo") {
        const result = await startXiaomiMimoProxy();
        return NextResponse.json(result);
      }
      if (!["codex", "xai"].includes(provider)) {
        return NextResponse.json({ error: "Proxy only supported for codex/xai/trae/windsurf/zed" }, { status: 400 });
      }
      return await startFixedCallbackProxy(provider, { appPort: searchParams.get("app_port") });
    }

    if (action === "poll-status") {
      const state = searchParams.get("state");
      if (!state) {
        return NextResponse.json({ error: "Missing state" }, { status: 400 });
      }
      let session;
      if (provider === "trae") session = getTraeSessionStatus(state);
      else if (provider === "windsurf") session = getWindsurfSessionStatus(state);
      else if (provider === "zed") session = getZedSessionStatus(state);
      else if (provider === "xai") session = getXaiSessionStatus(state);
      else if (provider === "codex") session = getCodexSessionStatus(state);
      else if (provider === "xiaomi-mimo") session = getXiaomiMimoSessionStatus(state);
      else return NextResponse.json({ error: "Poll only supported for codex/xai/trae/windsurf/zed/xiaomi-mimo" }, { status: 400 });
      if (!session) return NextResponse.json({ status: "unknown" });
      if (session.status === "done" || session.status === "error") {
        const payload = {
          status: session.status,
          ...(session.connectionId ? { connectionId: session.connectionId } : {}),
          ...(session.email ? { email: session.email } : {}),
          ...(session.status === "error" ? { error: "OAuth authentication failed" } : {}),
        };
        if (provider === "xiaomi-mimo" && session.status === "done") payload.result = session.result;
        if (provider === "xiaomi-mimo") {
          // Unlike the others this does not auto-exchange server-side, so a
          // finished session must survive until the client POSTs /exchange —
          // that call clears it. A failed one is cleared here instead.
          if (session.status === "error") {
            clearXiaomiMimoSession(state);
            stopXiaomiMimoProxy();
          }
          return NextResponse.json(payload);
        }
        if (provider === "trae") clearTraeSession(state);
        else if (provider === "windsurf") clearWindsurfSession(state);
        else if (provider === "zed") clearZedSession(state);
        else if (provider === "xai") clearXaiSession(state);
        else clearCodexSession(state);
        return NextResponse.json(payload);
      }
      return NextResponse.json({ status: session.status });
    }

    if (action === "stop-proxy") {
      if (provider === "trae") stopTraeProxy();
      else if (provider === "windsurf") stopWindsurfProxy();
      else if (provider === "zed") stopZedProxy();
      else if (provider === "xai") stopXaiProxy();
      else if (provider === "codex") stopCodexProxy();
      else if (provider === "xiaomi-mimo") stopXiaomiMimoProxy();
      else return NextResponse.json({ error: "Proxy only supported for codex/xai/trae/windsurf/zed/xiaomi-mimo" }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    if (action === "ide-status") {
      // Detect whether the IDE is installed locally (used by import-token UX).
      if (provider !== "trae" && provider !== "windsurf") {
        return NextResponse.json({ error: "ide-status only supported for trae/windsurf" }, { status: 400 });
      }
      const status = await detectIdeInstalled(provider);
      return NextResponse.json(status);
    }

    if (action === "device-code") {
      const providerData = getProvider(provider);
      if (providerData.flowType !== "device_code") {
        return NextResponse.json({ error: "Provider does not support device code flow" }, { status: 400 });
      }

      const authData = await generateAuthData(provider, null);
      const startUrl = searchParams.get("start_url");
      const region = searchParams.get("region");
      const authMethod = searchParams.get("auth_method");
      const deviceOptions = provider === "kiro"
        ? {
            ...(startUrl ? { startUrl } : {}),
            ...(region ? { region } : {}),
            ...(authMethod ? { authMethod } : {}),
          }
        : undefined;
      
      // Providers that don't use PKCE for device code (Grok CLI HAR: plain device_code, no challenge)
      const noPkceDeviceProviders = [
        "github",
        "kiro",
        "kimi",
        "kimi-coding",
        "kilocode",
        "codebuddy-cn",
        "codebuddy-intl",
        "qoder",
        "qoder-cn",
        "grok-cli",
        "muse",
        "glm",
        "nous",
      ];
      let deviceData;
      if (noPkceDeviceProviders.includes(provider)) {
        deviceData = await requestDeviceCode(provider, undefined, deviceOptions);
      } else {
        // Qwen and other PKCE providers
        deviceData = await requestDeviceCode(provider, authData.codeChallenge, deviceOptions);
      }

      return NextResponse.json({
        ...deviceData,
        // Prefer the verifier the provider's requestDeviceCode generated for
        // itself (qoder rolls its own PKCE pair); fall back to the generic one.
        codeVerifier: deviceData.codeVerifier || authData.codeVerifier,
      });
    }

    if (action === "lease-status") {
      // MiniMax Code desktop broker probe: is the desktop app installed,
      // running and signed in on this machine? Read-only — leases nothing.
      const MCODE_LEASE_PROVIDERS = ["minimax-code", "minimax-code-global"];
      if (!MCODE_LEASE_PROVIDERS.includes(provider)) {
        return NextResponse.json({ error: "lease-status only supported for minimax-code/minimax-code-global" }, { status: 400 });
      }
      const override = searchParams.get("data_dir");
      const dataDir = override ? String(override).trim() : resolveMcodeDataDir(null);
      try {
        const status = await requestStatus(dataDir);
        return NextResponse.json({ found: true, dataDir, ...status });
      } catch (error) {
        const code = error instanceof AuthLeaseError ? error.code : "INTERNAL_ERROR";
        return NextResponse.json({ found: false, dataDir, error: code, message: error.message });
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log(`OAuth GET error (${oauthErrorStatus(error)})`);
    return NextResponse.json({ error: oauthPublicErrorMessage(error) }, { status: oauthErrorStatus(error) });
  }
}

// POST /api/oauth/[provider]/exchange - Exchange code for tokens and save
// POST /api/oauth/[provider]/poll - Poll for token (device_code flow)
export async function POST(request, { params }) {
  try {
    const { provider, action } = await params;
    let body;
    try {
      body = await readRequestJson(request, { maxBytes: MAX_OAUTH_REQUEST_BODY_BYTES });
    } catch (error) {
      const status = error instanceof SyntaxError || error instanceof TypeError ? 400 : oauthErrorStatus(error);
      return NextResponse.json({ error: "Invalid or empty request body" }, { status });
    }
    const searchParams = new URL(request.url).searchParams;
    if (action === "start-proxy") {
      if (START_PROXY_QUERY_PRIVATE_KEYS.some((key) => searchParams.has(key))) {
        return NextResponse.json({ error: "OAuth state, verifier, and tokens are not accepted in start-proxy URLs" }, { status: 400 });
      }
      return await startFixedCallbackProxy(provider, body);
    }

    if (action === "lease-connect") {
      // MiniMax Code: create a connection that borrows the desktop app's
      // sign-in over the local auth-lease pipe (authType "mcode-lease"). The
      // router stores no tokens for it — the desktop broker owns refresh.
      const MCODE_LEASE_PROVIDERS = ["minimax-code", "minimax-code-global"];
      if (!MCODE_LEASE_PROVIDERS.includes(provider)) {
        return NextResponse.json({ error: "lease-connect only supported for minimax-code/minimax-code-global" }, { status: 400 });
      }
      const dataDir = body?.dataDir ? String(body.dataDir).trim() : resolveMcodeDataDir(null);
      try {
        // Validate availability up front so the user gets the broker's exact
        // failure reason instead of a dead connection.
        await requestLease(dataDir);
      } catch (error) {
        const code = error instanceof AuthLeaseError ? error.code : "INTERNAL_ERROR";
        return NextResponse.json({ error: error.message, code }, { status: 409 });
      }

      // Idempotent: one lease connection per (provider, data dir).
      resolveLeaseEndpoint(dataDir); // throws INVALID_REQUEST on a non-absolute override
      const existing = (await getProviderConnections({ provider }))
        .find((c) => c.authType === "mcode-lease" && resolveMcodeDataDir(c) === dataDir);
      if (existing) {
        return NextResponse.json({ success: true, connection: { id: existing.id, provider: existing.provider }, reused: true });
      }

      const connection = await createProviderConnection({
        provider,
        authType: "mcode-lease",
        name: provider === "minimax-code-global" ? "MiniMax Desktop (Lease, Global)" : "MiniMax Desktop (Lease)",
        providerSpecificData: { mcodeDataDir: dataDir },
        testStatus: "active",
      });
      return NextResponse.json({ success: true, connection: { id: connection.id, provider: connection.provider } });
    }

    if (action === "register-session") {
      // Session secrets, including Zed's RSA private key, stay in the body.
      if (START_PROXY_QUERY_PRIVATE_KEYS.some((key) => searchParams.has(key))) {
        return NextResponse.json({ error: "OAuth session fields are not accepted in register-session URLs" }, { status: 400 });
      }
      const state = body?.state;
      if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });
      let ok = false;
      if (provider === "trae") ok = registerTraeSession({ state });
      else if (provider === "windsurf") ok = registerWindsurfSession({ state });
      else if (provider === "zed") ok = registerZedSession({ state, codeVerifier: body?.codeVerifier, systemId: body?.systemId });
      else return NextResponse.json({ error: "register-session only supported for trae/windsurf/zed" }, { status: 400 });
      return NextResponse.json({ success: ok });
    }

    if (action === "exchange") {
      const { code, redirectUri, codeVerifier, state, meta, systemId } = body;

      // Xiaomi MiMo: no token exchange needed — the callback already decrypted the sk.
      // Just read the session result and create the connection.
      if (provider === "xiaomi-mimo") {
        if (!state) {
          return NextResponse.json({ error: "Missing state" }, { status: 400 });
        }
        const session = getXiaomiMimoSessionStatus(state);
        if (!session || session.status !== "done" || !session.result) {
          return NextResponse.json(
            { error: session?.error || "OAuth session not completed. Please restart the login flow." },
            { status: 400 },
          );
        }
        const { uid, accessToken, baseUrl } = session.result;

        // Desktop-exclusive Preview models authenticate with the account-session
        // passToken, which only lives in MiMo Desktop's cookie store — attach it
        // to the connection so those models work right after OAuth.
        let passToken = null;
        try {
          passToken = await readDesktopPassToken();
        } catch {
          // Desktop not installed / cookie DB locked — preview models stay unavailable.
        }

        try {
          const connection = await createProviderConnection({
            provider: "xiaomi-mimo",
            authType: "oauth",
            accessToken,
            refreshToken: null,
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            email: uid ? `${uid}@xiaomi` : null,
            displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
            providerSpecificData: {
              uid: uid || null,
              baseUrl: baseUrl || "https://api.xiaomimimo.com/v1",
              authMethod: "oauth",
              mimoPassToken: passToken?.passToken || null,
              mimoUserId: passToken?.userId || null,
              mimoCUserId: passToken?.cUserId || null,
            },
            testStatus: "active",
          });
          clearXiaomiMimoSession(state);
          stopXiaomiMimoProxy();
          return NextResponse.json({
            success: true,
            connection: {
              id: connection.id,
              provider: connection.provider,
              email: connection.email,
              displayName: connection.displayName,
            },
          });
        } catch (err) {
          clearXiaomiMimoSession(state);
          stopXiaomiMimoProxy();
          return NextResponse.json({ error: oauthPublicErrorMessage(err) }, { status: oauthErrorStatus(err) });
        }
      }

      // Trae/Windsurf: code is either a raw callback URL or a pasted token.
      // exchangeTokens() handles both paths; no PKCE, skip codex JWT extraction.
      if (provider === "trae" || provider === "windsurf") {
        const token = typeof code === "string" ? code.trim() : "";
        if (!token) {
          return NextResponse.json({ error: "Missing token or callback URL" }, { status: 400 });
        }
        try {
          const tokenData = await exchangeTokens(provider, token, null, null, state);
          const connection = await createProviderConnection({
            provider,
            authType: provider === "windsurf" ? "api_key" : "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });
          return NextResponse.json({
            success: true,
            connection: {
              id: connection.id,
              provider: connection.provider,
              email: connection.email,
              displayName: connection.displayName,
            }
          });
        } catch (err) {
          return NextResponse.json({ error: oauthPublicErrorMessage(err) }, { status: oauthErrorStatus(err) });
        }
      }

      // Detect if "code" is actually a raw JWT access token (starts with eyJ)
      if (code && code.startsWith("eyJ") && code.includes(".")) {
        const { extractCodexAccountInfo } = await import("@/lib/oauth/providers");
        const info = extractCodexAccountInfo(code);

        // Also decode JWT directly for ChatGPT website tokens which use
        // top-level account_id/plan_type instead of nested openai auth claims
        let directPayload = {};
        try {
          const b64 = code.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
          directPayload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        } catch {}

        const accountId = info.chatgptAccountId || directPayload.account_id;
        const planType = info.chatgptPlanType || directPayload.plan_type;
        const email = info.email || directPayload.email;

        const providerSpecificData = { authMethod: "access_token" };
        if (accountId) providerSpecificData.chatgptAccountId = accountId;
        if (planType) providerSpecificData.chatgptPlanType = planType;

        const connection = await createProviderConnection({
          provider,
          authType: "access_token",
          accessToken: code,
          email: email || null,
          providerSpecificData,
          testStatus: "active",
        });

        return NextResponse.json({
          success: true,
          connection: {
            id: connection.id,
            provider: connection.provider,
            email: connection.email,
            displayName: connection.displayName,
          }
        });
      }

      // Cline and ClinePass use authorization_code without PKCE. Kimchi returns a browser token.
      const noPkceExchangeProviders = ["cline", "clinepass", "kimchi"];
      if (!code || !redirectUri || (!codeVerifier && !noPkceExchangeProviders.includes(provider))) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }

      // Exchange code for tokens (meta carries provider-specific params, e.g. gitlab clientId/baseUrl).
      // systemId (Zed) is merged into meta so the login attempt's own id is
      // used instead of a freshly prepared one. Ignored by other providers.
      const tokenData = await exchangeTokens(provider, code, redirectUri, codeVerifier, state, {
        ...(meta || {}),
        ...(systemId ? { systemId } : {}),
      });

      // Save to database
      const connection = await createProviderConnection({
        provider,
        authType: "oauth",
        ...tokenData,
        expiresAt: tokenData.expiresIn 
          ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString() 
          : null,
        testStatus: "active",
      });

      return NextResponse.json({ 
        success: true, 
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.displayName,
        }
      });
    }

    if (action === "poll") {
      const { deviceCode, codeVerifier, extraData } = body;

      if (!deviceCode) {
        return NextResponse.json({ error: "Missing device code" }, { status: 400 });
      }

      // Providers that don't use PKCE for device code
      const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-intl", "glm", "nous"];
      let result;
      if (noPkceProviders.includes(provider)) {
        // kimi needs extraData._kimiDeviceId for stable X-Msh-Device-Id (CLIProxyAPI parity)
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "kiro") {
        // Kiro needs extraData (clientId, clientSecret) from device code response
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "qoder" || provider === "qoder-cn") {
        // Qoder needs both the PKCE verifier (codeVerifier) and the machineId
        // captured at device-code time (extraData._qoderMachineId) so
        // mapTokens can persist it for COSY signing.
        if (!codeVerifier) {
          return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier, extraData);
      } else {
        // Qwen and other PKCE providers
        if (!codeVerifier) {
          return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier);
      }

      if (result.success) {
        // Save to database (legacy kimi-coding OAuth → dual-auth kimi)
        const providerId = provider === "kimi-coding" ? "kimi" : provider;
        const connection = await createProviderConnection({
          provider: providerId,
          authType: "oauth",
          ...result.tokens,
          expiresAt: result.tokens.expiresIn 
            ? new Date(Date.now() + result.tokens.expiresIn * 1000).toISOString() 
            : null,
          testStatus: "active",
        });

        return NextResponse.json({ 
          success: true, 
          connection: {
            id: connection.id,
            provider: connection.provider,
          }
        });
      }

      return NextResponse.json({ success: false, ...publicPollFailure(result) });
    }

    if (action === "manual-code") {
      if (provider !== "xai") {
        return NextResponse.json({ error: "Manual code only supported for xai" }, { status: 400 });
      }
      const { code, state } = body;
      const connection = await completeXaiManualCode(String(code || "").trim(), String(state || "").trim());
      return NextResponse.json({ success: true, connection });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log(`OAuth POST error (${oauthErrorStatus(error)})`);
    return NextResponse.json({ error: oauthPublicErrorMessage(error) }, { status: oauthErrorStatus(error) });
  }
}
