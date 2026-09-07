const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const sharp = require("sharp");
let child, port;
const clients = new Set();

before(async () => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  child = spawn(process.execPath, ["server.js"], { cwd: require("node:path").join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: "", TRUSTED_PROXY_IPS: "127.0.0.1,::1",
      PER_IP_UPLOAD_LIMIT: "100", GLOBAL_UPLOAD_LIMIT: "200", UPLOAD_TIMEOUT_MS: "250",
      INVITE_TTL_MS: "3000", GLOBAL_TEXT_LIMIT: "600", PER_IP_TEXT_LIMIT: "60" },
    stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server failed to start")), 10000);
    child.stdout.on("data", (data) => {
      if (data.toString().includes("Server started")) { clearTimeout(timeout); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
});

after(async () => {
  for (const ws of clients) { ws.terminate(); }
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
});

async function connect(roomId = randomUUID(), headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${roomId}`, { headers });
  clients.add(ws);
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  ws.take = async (type, predicate = () => true) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const index = messages.findIndex((m) => m.type === type && predicate(m));
      if (index >= 0) { return messages.splice(index, 1)[0]; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing ${type}: ${JSON.stringify(messages)}`);
  };
  ws.json = (m) => ws.send(JSON.stringify(m));
  await once(ws, "open");
  return ws;
}

async function close(ws) {
  if (ws.readyState === WebSocket.CLOSED) { return; }
  const ended = once(ws, "close");
  ws.close();
  await ended;
  clients.delete(ws);
}

test("null messages are rejected and rooms are reusable after repeated disconnects", async () => {
  for (let i = 0; i < 25; i++) {
    const ws = await connect();
    await ws.take("textSnapshot");
    if (i === 0) {
      ws.send("null");
      await ws.take("protocolError");
      ws.json({ type: "textUpdate", text: "alive", baseRevision: 0, updateId: "one" });
      assert.equal((await ws.take("textUpdate")).text, "alive");
    }
    await close(ws);
  }
});

test("trusted proxy chain ignores a forged leftmost address and accepts HTTPS origin", async () => {
  const ws = await connect(randomUUID(), { "X-Forwarded-For": "1.2.3.4, 198.51.100.9",
    "X-Forwarded-Proto": "https", Origin: `https://127.0.0.1:${port}` });
  assert.deepEqual((await ws.take("userList")).users, ["198.51.100.9"]);
  await close(ws);
});

test("text snapshots and revision conflicts preserve the accepted document", async () => {
  const roomId = randomUUID();
  const a = await connect(roomId), b = await connect(roomId);
  await a.take("textSnapshot"); await b.take("textSnapshot");
  a.json({ type: "textUpdate", text: "first", baseRevision: 0, updateId: "a" });
  assert.equal((await a.take("textUpdate")).revision, 1);
  await b.take("textUpdate");
  b.json({ type: "textUpdate", text: "stale", baseRevision: 0, updateId: "b" });
  assert.equal((await b.take("textConflict")).text, "first");
  const c = await connect(roomId);
  assert.equal((await c.take("textSnapshot")).text, "first");
  await close(a); await close(b); await close(c);
});

test("upload timeouts release admission and completions carry distinct transfer IDs", async () => {
  const roomId = randomUUID();
  const a = await connect(roomId), b = await connect(roomId);
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const start = (ws, id) => ws.json({ type: "imageUploadStart", uploadId: id, filename: "same.png",
    mimeType: "image/png", size: buffer.length });
  start(a, "abandoned");
  await a.take("imageUploadReady");
  assert.match((await a.take("imageUploadError")).error, /timed out/);
  start(a, "first"); start(b, "second");
  await a.take("imageUploadReady"); await b.take("imageUploadReady");
  for (const [ws, id] of [[a, "first"], [b, "second"]]) {
    ws.json({ type: "imageUploadChunk", uploadId: id, filename: "same.png", chunkIndex: 0,
      totalChunks: 1, data: buffer.toString("base64") });
  }
  for (const ws of [a, b]) {
    assert.equal((await ws.take("imageUploadComplete", (m) => m.uploadId === "first")).mimeType, "image/png");
    await ws.take("imageUploadComplete", (m) => m.uploadId === "second");
  }
  await close(a); await close(b);
});

test("accepting an invite consumes it and resolves other waiting requests", async () => {
  const owner = await connect();
  owner.json({ type: "generateInvite" });
  const { pin } = await owner.take("inviteGenerated");
  const request = () => fetch(`http://127.0.0.1:${port}/request-join`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) }).then((r) => r.json());
  const first = request();
  const join = await owner.take("joinRequest");
  const second = request();
  await owner.take("joinRequest");
  owner.json({ type: "respondInvite", requestId: join.requestId, accept: true });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, false);
  assert.equal((await request()).ok, false);
  await close(owner);
});
