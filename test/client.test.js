const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

// A small DOM boundary for client state tests; no browser or smoke tooling is used.
function element(tag = "div") {
  const classes = new Set();
  return {
    tagName: tag, children: [], dataset: {}, value: "", textContent: "", handlers: {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    append(...children) { children.forEach((child) => this.appendChild(child)); },
    after(child) { this.afterElement = child; },
    insertBefore(child) { this.appendChild(child); },
    replaceChildren(...children) { this.children = children; },
    remove() { this.parentNode.children = this.parentNode.children.filter((child) => child !== this); },
    setAttribute() {}, removeAttribute() {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
  };
}

function client(historyEnabled = true) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) { elements.set(id, element()); }
    return elements.get(id);
  };
  let socket;
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { socket = this; this.readyState = 1; this.sent = []; }
    send(data) { this.sent.push(JSON.parse(data)); }
  }
  const qrCalls = [];
  class QRCode {
    static CorrectLevel = { M: 0, H: 1 };
    constructor(target, options) { qrCalls.push(options.text); }
  }
  const timers = new Map();
  let nextTimer = 0;
  const context = { document: { getElementById: get, querySelector: get, createElement: element,
    createTextNode: (text) => ({ textContent: text }), body: { dataset: { roomId: "room" } } },
    window: { location: { protocol: "http:", host: "localhost", href: "http://localhost/room" } },
    WebSocket: Socket, QRCode, crypto: webcrypto, TextEncoder, URL, console: { log() {}, error() {} },
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    btoa: (data) => Buffer.from(data, "binary").toString("base64") };
  vm.createContext(context);
  for (const file of ["link-detection.js", "text-sync.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../public", file), "utf8"), context);
  }
  socket.onopen();
  const receive = (message) => socket.onmessage({ data: JSON.stringify(message) });
  receive(historyEnabled
    ? { type: "textSnapshot", text: "", revision: 0, maxTextBytes: 65536 }
    : { type: "textMode", historyEnabled: false, maxTextBytes: 65536 });
  return { get, socket, receive, qrCalls, flush: () => {
    const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn());
  } };
}

test("client debounces updates and preserves its draft during a revision conflict", () => {
  const c = client(), textarea = c.get("sharedText");
  textarea.value = "draft";
  textarea.handlers.input();
  textarea.value = "newer draft";
  textarea.handlers.input();
  c.flush();
  assert.equal(c.socket.sent.length, 1);
  assert.equal(c.socket.sent[0].text, "newer draft");
  c.receive({ type: "textConflict", revision: 1, text: "remote text" });
  assert.equal(textarea.value, "newer draft");
  assert.equal(textarea.afterElement.hidden, false);
  const shareDraft = textarea.afterElement.children.at(-1);
  shareDraft.handlers.click();
  const update = c.socket.sent.at(-1);
  assert.equal(update.baseRevision, 1);
  c.receive({ type: "textUpdate", revision: 2, text: update.text, updateId: update.updateId });
  assert.equal(textarea.value, "newer draft");
  assert.equal(textarea.afterElement.hidden, true);
});

test("relay-only client sends and applies deltas without snapshot state", () => {
  const sender = client(false), textarea = sender.get("sharedText");
  textarea.value = "hello";
  textarea.handlers.input();
  sender.flush();
  assert.deepEqual(sender.socket.sent[0], {
    type: "textDelta", start: 0, deleteCount: 0, insert: "hello", updateId: sender.socket.sent[0].updateId,
  });
  sender.receive({ type: "textDeltaAccepted", updateId: sender.socket.sent[0].updateId });
  textarea.value = "hello there";
  textarea.handlers.input();
  sender.flush();
  assert.deepEqual(sender.socket.sent[1], {
    type: "textDelta", start: 5, deleteCount: 0, insert: " there", updateId: sender.socket.sent[1].updateId,
  });

  const lateJoiner = client(false);
  lateJoiner.receive(sender.socket.sent[1]);
  assert.equal(lateJoiner.get("sharedText").value, " there");
});

test("client renders simultaneous same-name transfers and self-contained late completions", () => {
  const c = client();
  for (const id of ["a", "b"]) {
    c.receive({ type: "imageUploadStart", uploadId: id, filename: "same.png" });
  }
  for (const id of ["a", "b", "joined-late"]) {
    c.receive({ type: "imageUploadComplete", uploadId: id, filename: "same.png",
      data: "YWJj", mimeType: "image/png", width: 1, height: 1, size: 3 });
  }
  assert.equal(c.get("sharedImages").children.length, 3);
});

test("disconnected edits survive reconnection and require a choice if shared text changed", () => {
  const c = client(), textarea = c.get("sharedText");
  c.socket.readyState = 3;
  c.socket.onclose({ code: 1006 });
  textarea.value = "offline draft";
  textarea.handlers.input();
  c.flush();
  assert.equal(c.socket.sent.length, 0);
  c.receive({ type: "textSnapshot", revision: 3, text: "remote edit", maxTextBytes: 65536 });
  assert.equal(textarea.value, "offline draft");
  assert.equal(textarea.afterElement.hidden, false);
});


test("relay retries rejected edits from the accepted baseline and retains newer typing", () => {
  const c = client(false), textarea = c.get("sharedText");
  textarea.value = "first";
  textarea.handlers.input();
  c.flush();
  const rejected = c.socket.sent[0];
  textarea.value = "first and second";
  textarea.handlers.input();
  c.flush();
  assert.equal(c.socket.sent.length, 1);
  c.receive({ type: "textUpdateError", updateId: rejected.updateId, error: "Rate limited", retryAfterMs: 1000 });
  c.flush();
  const retried = c.socket.sent[1];
  assert.equal(retried.start, 0);
  assert.equal(retried.insert, "first and second");
  c.receive({ type: "textDeltaAccepted", updateId: rejected.updateId });
  c.flush();
  assert.equal(c.socket.sent.length, 2);
  c.receive({ type: "textDeltaAccepted", updateId: retried.updateId });
  textarea.value += "!";
  textarea.handlers.input();
  c.flush();
  assert.equal(c.socket.sent[2].insert, "!");
  assert.equal(c.socket.sent[2].start, retried.insert.length);
});

test("relay sends edits typed while an accepted operation is pending", () => {
  const c = client(false), textarea = c.get("sharedText");
  textarea.value = "a";
  textarea.handlers.input();
  c.flush();
  textarea.value = "ab";
  textarea.handlers.input();
  c.flush();
  assert.equal(c.socket.sent.length, 1);
  c.receive({ type: "textDeltaAccepted", updateId: c.socket.sent[0].updateId });
  c.flush();
  assert.equal(c.socket.sent[1].start, 1);
  assert.equal(c.socket.sent[1].insert, "b");
});

test("remote relay edits do not mark an unsent draft as delivered", () => {
  const c = client(false), textarea = c.get("sharedText");
  textarea.value = "local";
  textarea.handlers.input();
  c.receive({ type: "textDelta", start: 0, deleteCount: 0, insert: "remote " });
  assert.equal(textarea.value, "remote local");
  c.flush();
  assert.equal(c.socket.sent[0].start, 7);
  assert.equal(c.socket.sent[0].insert, "local");
});

test("remote relay edits survive acknowledgement of a pending local operation", () => {
  const c = client(false), textarea = c.get("sharedText");
  textarea.value = "local";
  textarea.handlers.input();
  c.flush();
  c.receive({ type: "textDelta", start: 0, deleteCount: 0, insert: "remote " });
  c.receive({ type: "textDeltaAccepted", updateId: c.socket.sent[0].updateId });
  c.flush();
  assert.equal(c.socket.sent.length, 1);
  textarea.value += "!";
  textarea.handlers.input();
  c.flush();
  assert.equal(c.socket.sent[1].start, "remote local".length);
  assert.equal(c.socket.sent[1].insert, "!");
});

test("QR generation limits work and reports oversized lines", () => {
  const c = client();
  c.get("sharedText").value = "x".repeat(1001) + "\n" + Array(30).fill("example").join("\n");
  c.get("generate-barcodes").handlers.click();
  assert.equal(c.qrCalls.length, 20); // Room URL plus 19 eligible text lines.
  const items = c.get(".barcodes").children;
  assert.match(items[0].children[0].children[0].textContent, /could not be encoded/);
  assert.match(items.at(-1).children[0].textContent, /first 20/);
});
