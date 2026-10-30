import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";

const configHome = await mkdtemp(join(tmpdir(), "request-logger-test-"));
const previousConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = configHome;
const { default: plugin } = await import("../dist/index.js");
const root = join(configHome, "opencode", "logs", "request-logger");

afterAll(async () => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(configHome, { recursive: true, force: true });
});

async function setup() {
  assert.equal(typeof plugin, "object", "OpenCode V2 requires a plugin definition, not a V1 function");
  assert.equal(plugin.id, "opencode-request-logger");
  const hooks = new Map();
  const originalFetch = globalThis.fetch;
  await plugin.setup({ session: { hook: async (name, handler) => hooks.set(name, handler) } });
  assert.equal(globalThis.fetch, originalFetch, "must not patch process-wide fetch");
  return hooks;
}

async function logs(sessionID) {
  const dir = join(root, sessionID);
  const files = await readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(files.sort().map(async (file) => JSON.parse(await readFile(join(dir, file), "utf8"))));
}

test("registers native V2 HTTP hooks and preserves the outgoing request", async () => {
  const hooks = await setup();
  const body = { messages: [{ role: "user", content: "hello" }] };
  const request = new Request("https://provider.example/messages", {
    method: "POST",
    headers: { authorization: "Bearer test-secret" },
    body: JSON.stringify(body),
  });
  await hooks.get("http.request")({ sessionID: "session-http", kind: "primary", request });
  assert.deepEqual(await request.json(), body);
  const entries = await logs("session-http");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].body, body);
  assert.equal(entries[0].url, request.url);
  assert.ok(!JSON.stringify(entries).includes("test-secret"));
});

test("logs different provider body shapes and all request kinds", async () => {
  const hook = (await setup()).get("http.request");
  const bodies = [{ messages: [] }, { input: [] }, { contents: [] }, { custom: true }];
  const kinds = ["primary", "compaction", "title", "generate"];
  for (const [index, body] of bodies.entries()) {
    await hook({
      sessionID: "session-kinds", kind: kinds[index],
      request: new Request("https://provider.example/generate", {
        method: "POST", body: JSON.stringify(body),
      }),
    });
  }
  assert.deepEqual((await logs("session-kinds")).map((entry) => entry.body), bodies);
});

test("keeps concurrent sessions separate and records repeated HTTP attempts", async () => {
  const hook = (await setup()).get("http.request");
  await Promise.all(["session-a", "session-b", "session-a"].map((sessionID) => hook({
    sessionID,
    request: new Request("https://provider.example/generate", {
      method: "POST", body: JSON.stringify({ input: [sessionID] }),
    }),
  })));
  assert.equal((await logs("session-a")).length, 2);
  assert.deepEqual((await logs("session-b")).map((entry) => entry.body), [{ input: ["session-b"] }]);
});

test("ignores empty and non-JSON requests without consuming them", async () => {
  const hook = (await setup()).get("http.request");
  const request = new Request("https://provider.example/generate", { method: "POST", body: "not json" });
  await hook({ sessionID: "session-invalid", request });
  assert.equal(await request.text(), "not json");
  await hook({ sessionID: "session-invalid", request: new Request("https://provider.example") });
  assert.deepEqual(await logs("session-invalid"), []);
});

test("filesystem failures never interrupt model dispatch", async () => {
  await writeFile(join(root, "session-blocked"), "not a directory");
  const hook = (await setup()).get("http.request");
  const request = new Request("https://provider.example/generate", { method: "POST", body: '{"input":[]}' });
  await hook({ sessionID: "session-blocked", request });
  assert.deepEqual(await request.json(), { input: [] });
});

test("restricts new log permissions and sanitizes session paths", async () => {
  const hook = (await setup()).get("http.request");
  await hook({
    sessionID: "../outside",
    request: new Request("https://provider.example/generate", { method: "POST", body: '{"input":[]}' }),
  });
  const directory = join(root, "___outside");
  const [file] = await readdir(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
});

test("logs WebSocket frames without changing their contents", async () => {
  const hook = (await setup()).get("experimental.ws.send");
  const body = { type: "response.create", input: [{ role: "user", content: "hello" }] };
  const event = { sessionID: "session-ws", frame: JSON.stringify(body) };
  const frame = event.frame;
  await hook(event);
  assert.equal(event.frame, frame);
  const [entry] = await logs("session-ws");
  assert.deepEqual(entry.body, body);
  assert.equal(entry.url, "websocket");
  await hook({ sessionID: "session-ws", frame: "not json" });
  assert.equal((await logs("session-ws")).length, 1);
});
