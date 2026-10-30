import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const LOG_ROOT = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
  "logs",
  "request-logger",
);

let sequence = 0;
function writeLog(sessionId: string, url: string, body: unknown): void {
  // Session IDs must never be able to escape the log directory.
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  const dir = join(LOG_ROOT, safeSessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(sequence++).padStart(4, "0");
  const file = join(dir, `${ts}_${seq}.json`);

  const envelope = {
    timestamp: new Date().toISOString(),
    url,
    body,
  };

  writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}

const plugin = Plugin.define({
  id: "opencode-request-logger",
  async setup(ctx) {
    await ctx.session.hook("http.request", async (event) => {
      try {
        if (!event.request.body) return;
        // Native bodies are one-shot streams; reading a clone preserves dispatch.
        const body: unknown = await event.request.clone().json();
        writeLog(event.sessionID, event.request.url, body);
      } catch {
        // Malformed/non-JSON bodies and filesystem failures must not break dispatch.
      }
    });
    await ctx.session.hook("experimental.ws.send", async (event) => {
      try {
        // The frame hook does not expose a URL; do not guess the provider endpoint.
        writeLog(event.sessionID, "websocket", JSON.parse(event.frame));
      } catch {
        // Logging must not alter or interrupt the outgoing frame.
      }
    });
  },
});

export default plugin;
