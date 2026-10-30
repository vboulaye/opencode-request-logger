# opencode-request-logger

An [OpenCode](https://opencode.ai) plugin that logs raw LLM request bodies to disk for debugging and analysis.

## What it does

Logs outgoing JSON provider HTTP requests and WebSocket frames through OpenCode V2's native session hooks. Each request is written as a timestamped JSON file, organized by session ID.

**Log location:** `$XDG_CONFIG_HOME/opencode/logs/request-logger/<sessionId>/<timestamp>_<seq>.json`, falling back to `~/.config/opencode/logs/request-logger/` when `XDG_CONFIG_HOME` is unset.

Each file contains:

```json
{
  "timestamp": "2026-03-04T12:00:00.000Z",
  "url": "https://api.anthropic.com/v1/messages",
  "body": { "...raw request body..." }
}
```

## How it works

The plugin uses `Plugin.define` from `@opencode/plugin` (SDK 2.2.3):

1. **`http.request` hook** — reads a clone of each native provider request, preserving its body for dispatch.
2. **`experimental.ws.send` hook** — logs outgoing JSON frames for WebSocket-backed providers. These entries use `"url": "websocket"` because the frame event does not expose the connection URL. This hook is experimental in OpenCode.

The native hooks cover primary, compaction, title, and transient generation requests. There is no process-wide fetch patch or shared current-session variable. Each HTTP attempt/frame is recorded separately, including retries. Empty and non-JSON bodies are skipped; logging failures do not interrupt requests. Requests outside these hooks are not captured.

**Security:** Raw bodies can contain prompts, source code, tool results, personal data, and secrets. Logs are not redacted or automatically deleted. Keep them private and remove them when no longer needed. HTTP headers are not recorded. New session directories use mode `0700`; new log files use `0600` (existing directory permissions are unchanged).

## Installation

Requires OpenCode V2 and Bun 1.4.4 or newer. OpenCode V1 is no longer supported.

```bash
# From the plugin directory
bun install --frozen-lockfile
bun run build
```

Then add to your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [ "/absolute/path/to/opencode-request-logger" ]
}
```

Use the plugin directory, not `index.ts` or `dist/index.js`. If migrating an existing configuration, rename `plugin` to `plugins`. Run `/reload` in OpenCode after rebuilding to reload the plugin.

## Development

```bash
bun install --frozen-lockfile
bun run test
```

Tests build and import the compiled entrypoint, then exercise the hooks with local fixtures; they do not call an LLM provider. To undo the migration, restore the previous plugin revision and matching lockfile, reinstall and rebuild. The previous revision only supports OpenCode V1.
