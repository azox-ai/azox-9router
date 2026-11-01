import pkg from "../../package.json" with { type: "json" };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_HEADERS = ["X-Request-ID", "X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID"];

// Test-only: validate raw relationships before replacing exact dynamic fields.
export function normalizeDynamicHeaders(provider, headers, {
  packageVersion = pkg.version,
  nodeVersion = process.version,
} = {}) {
  const cline = provider === "cline" || provider === "clinepass";
  const codebuddy = provider === "codebuddy-cn" || provider === "codebuddy-intl";
  if (!cline && !codebuddy && provider !== "kimi") return headers;
  function requireHeader(condition, key) {
    if (!condition) throw new Error(`Invalid dynamic header: ${provider}/${key}`);
  }
  requireHeader(headers !== null && typeof headers === "object" && !Array.isArray(headers), "headers");
  function value(key) {
    requireHeader(Object.hasOwn(headers, key) && typeof headers[key] === "string", key);
    return headers[key];
  }
  const out = { ...headers };
  if (cline) {
    const expected = {
      "User-Agent": `9Router/${packageVersion}`,
      "X-CLIENT-VERSION": packageVersion,
      "X-CORE-VERSION": packageVersion,
      "X-PLATFORM-VERSION": nodeVersion,
    };
    for (const [key, wanted] of Object.entries(expected)) {
      requireHeader(value(key) === wanted, key);
      out[key] = key === "User-Agent" ? "9Router/<PACKAGE_VERSION>"
        : key === "X-PLATFORM-VERSION" ? "<NODE_VERSION>" : "<PACKAGE_VERSION>";
    }
  } else if (provider === "kimi") {
    requireHeader(value("X-Msh-Version") === packageVersion, "X-Msh-Version");
    out["X-Msh-Version"] = "<PACKAGE_VERSION>";
  } else {
    for (const key of UUID_HEADERS) requireHeader(UUID_V4.test(value(key)), key);
    const request = headers["X-Request-ID"].toLowerCase();
    for (const key of ["X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
      requireHeader(headers[key].toLowerCase() === request, key);
    }
    requireHeader(headers["X-Conversation-ID"].toLowerCase() !== request, "X-Conversation-ID");
    for (const key of UUID_HEADERS) out[key] = key === "X-Conversation-ID" ? "<CONVERSATION_UUID>" : "<REQUEST_UUID>";
  }
  return out;
}
