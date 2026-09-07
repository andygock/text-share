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

function client() {
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
  const timers = new Map();
  let nextTimer = 0;
  const context = { document: { getElementById: get, querySelector: get, createElement: element,
    createTextNode: (text) => ({ textContent: text }), body: { dataset: { roomId: "room" } } },
    window: { location: { protocol: "http:", host: "localhost", href: "http://localhost/room" } },
    WebSocket: Socket, crypto: webcrypto, TextEncoder, console: { log() {}, error() {} },
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    btoa: (data) => Buffer.from(data, "binary").toString("base64") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"), context);
  socket.onopen();
  const receive = (message) => socket.onmessage({ data: JSON.stringify(message) });
  receive({ type: "textSnapshot", text: "", revision: 0, maxTextBytes: 65536 });
  return { get, socket, receive, flush: () => {
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
