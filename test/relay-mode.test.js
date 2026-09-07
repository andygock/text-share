const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function connect(port, roomId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${roomId}`);
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  await once(ws, "open");
  ws.take = async (type) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) { return messages.splice(index, 1)[0]; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing ${type}: ${JSON.stringify(messages)}`);
  };
  ws.messages = messages;
  return ws;
}

test("relay-only mode forwards deltas and never replays room text", async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: "",
      TEXT_HISTORY_ENABLED: "false", PER_IP_TEXT_LIMIT: "60", GLOBAL_TEXT_LIMIT: "600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const clients = [];
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server failed to start")), 10000);
      child.stdout.on("data", (data) => {
        if (data.toString().includes("Server started")) { clearTimeout(timeout); resolve(); }
      });
      child.once("exit", (code) => reject(new Error(`Server exited: ${code}`)));
    });
    const roomId = randomUUID();
    const sender = await connect(port, roomId);
    const recipient = await connect(port, roomId);
    clients.push(sender, recipient);
    assert.equal((await sender.take("textMode")).historyEnabled, false);
    await recipient.take("textMode");
    sender.send(JSON.stringify({ type: "textDelta", start: 0, deleteCount: 0, insert: "new" }));
    assert.deepEqual(await recipient.take("textDelta"), {
      type: "textDelta", start: 0, deleteCount: 0, insert: "new",
    });
    assert.equal(sender.messages.some((message) => message.type === "textDelta"), false);

    sender.close();
    recipient.close();
    await Promise.all([once(sender, "close"), once(recipient, "close")]);
    const later = await connect(port, roomId);
    clients.push(later);
    assert.equal((await later.take("textMode")).historyEnabled, false);
    assert.equal(later.messages.some((message) =>
      message.type === "textSnapshot" || message.insert === "new"), false);
  } finally {
    for (const ws of clients) { ws.terminate(); }
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
