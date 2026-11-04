import { registerHooks } from "node:module";
import { close } from "./session-owner-driver.mjs";

// Dependency injection for the production helper in a separate Node process.
// No application bootstrap, home database, account credentials or network calls.
const driverUrl = new URL("./session-owner-driver.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/db/driver.js" || specifier === "@/shared/constants/providers.js") {
      return { url: driverUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { affinityIdentity, claimOwner } = await import("../../src/sse/services/sessionAffinity.js");
process.send({ ready: true });
process.once("message", async () => {
  try {
    const identity = affinityIdentity("concurrent-session", "codex", "fixture-key");
    const result = await claimOwner(identity, process.env.AFFINITY_TEST_CANDIDATE);
    process.send({ connectionId: result.owner.connectionId, created: result.created });
  } catch (error) {
    process.send({ error: error.code || "worker_failure" });
    process.exitCode = 1;
  } finally {
    close();
    process.disconnect();
  }
});
