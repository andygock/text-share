const { test } = require("node:test");
const assert = require("node:assert/strict");
const room = require("../room-manager");
const { handleImageUploadChunk, startUpload, finishUpload } = require("../upload-handler");
const { sendJson } = require("../socket-utils");
const { booleanFlag, positiveInteger } = require("../config");

function socket() {
  return { readyState: 1, bufferedAmount: 0, messages: [],
    send(data, callback) { this.messages.push(JSON.parse(data)); callback?.(); },
    terminate() { this.readyState = 3; } };
}

test("room admission is read-only and departures are idempotent", () => {
  room.rooms.clear();
  room.clientIpCount.clear();
  for (let i = 0; i < 25; i++) {
    assert.equal(room.canJoinRoom(String(i), "ip").allowed, true);
    assert.equal(room.rooms.size, 0);
    const ws = socket();
    room.joinRoom(String(i), ws, "ip");
    room.leaveRoom(String(i), ws, "ip");
    room.leaveRoom(String(i), ws, "ip");
    assert.equal(room.clientIpCount.size, 0);
  }
  const a = socket(), b = socket();
  room.joinRoom("shared", a, "ip");
  room.joinRoom("shared", b, "ip");
  room.leaveRoom("shared", a, "ip");
  room.leaveRoom("shared", a, "ip");
  assert.equal(room.clientIpCount.get("ip"), 1);
  room.leaveRoom("shared", b, "ip");
});

test("the final departure explicitly destroys retained room text", () => {
  room.rooms.clear();
  room.clientIpCount.clear();
  const ws = socket();
  room.joinRoom("history", ws, "ip");
  const clients = room.rooms.get("history");
  clients.textState = { text: "private text", revision: 1 };
  room.leaveRoom("history", ws, "ip");
  assert.equal(clients.textState, null);
  assert.equal(room.rooms.has("history"), false);
});

test("rejected IP admission does not allocate rooms", () => {
  const clients = Array.from({ length: 5 }, socket);
  clients.forEach((ws) => room.joinRoom("full", ws, "ip"));
  assert.equal(room.canJoinRoom("new", "ip").allowed, false);
  assert.equal(room.rooms.size, 1);
  clients.forEach((ws) => room.leaveRoom("full", ws, "ip"));
});

function upload(size = 6) {
  const ws = socket();
  const clients = new Set([ws]);
  const state = startUpload(ws, clients, { uploadId: "one", filename: "test.png", size });
  return { ws, clients, state };
}

function chunk(index, total, data) {
  return { uploadId: "one", filename: "test.png", chunkIndex: index, totalChunks: total,
    data: Buffer.from(data).toString("base64") };
}

test("duplicate final chunks invoke processing once", async () => {
  const { ws, clients } = upload(3);
  let resolve, calls = 0;
  const processor = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const first = handleImageUploadChunk(chunk(0, 1, "abc"), ws, clients, processor, 100, 10, 100);
  await handleImageUploadChunk(chunk(0, 1, "abc"), ws, clients, processor, 100, 10, 100);
  assert.equal(calls, 1);
  resolve({ size: 3, buffer: Buffer.from("abc"), width: 1, height: 1, mimeType: "image/png" });
  await first;
  assert.equal(ws.messages.filter((m) => m.type === "imageUploadComplete").length, 1);
  assert.equal(ws.imageUploadState, null);
});

test("conflicting duplicates abort without bypassing the size limit", async () => {
  const { ws, clients } = upload();
  const processor = () => assert.fail("must not process a conflicting upload");
  await handleImageUploadChunk(chunk(0, 2, "abc"), ws, clients, processor, 100, 10, 100);
  await handleImageUploadChunk(chunk(0, 2, "abcdefghijkl"), ws, clients, processor, 100, 10, 100);
  assert.equal(ws.imageUploadState, null);
  assert.match(ws.messages.at(-1).error, /duplicate/);
});

test("independently padded chunks assemble correctly and declared size is enforced", async () => {
  const { ws, clients } = upload(2);
  const processor = async (buffer) => {
    assert.equal(buffer.toString(), "ab");
    return { size: 2, buffer, width: 1, height: 1, mimeType: "image/png" };
  };
  await handleImageUploadChunk(chunk(0, 2, "a"), ws, clients, processor, 100, 10, 100);
  await handleImageUploadChunk(chunk(1, 2, "b"), ws, clients, processor, 100, 10, 100);
  const invalid = upload(5);
  await handleImageUploadChunk(chunk(0, 1, "abc"), invalid.ws, invalid.clients,
    () => assert.fail("must reject truncated file"), 100, 10, 100);
  assert.equal(invalid.ws.imageUploadState, null);
});

test("cancellation suppresses late processing results without clearing a newer upload", async () => {
  const { ws, clients, state } = upload(3);
  let resolve;
  const pending = handleImageUploadChunk(chunk(0, 1, "abc"), ws, clients,
    () => new Promise((done) => { resolve = done; }), 100, 10, 100);
  finishUpload(ws, clients, state, "Cancelled");
  const next = startUpload(ws, clients, { uploadId: "two", filename: "next.png", size: 3 });
  resolve({ size: 3, buffer: Buffer.from("abc") });
  await pending;
  assert.equal(ws.imageUploadState, next);
  assert.equal(ws.messages.some((m) => m.type === "imageUploadComplete"), false);
  finishUpload(ws, clients, next);
});

test("slow recipients are disconnected before more data is queued", () => {
  const ws = socket();
  ws.bufferedAmount = 3 * 1024 * 1024;
  assert.equal(sendJson(ws, { text: "hello" }), false);
  assert.equal(ws.readyState, 3);
  assert.equal(ws.messages.length, 0);
});

test("processing concurrency rejects excess work and releases slots after errors", async () => {
  const first = upload(3), second = upload(3), third = upload(3);
  const releases = [];
  const processor = () => new Promise((resolve) => releases.push(resolve));
  const work = [first, second].map(({ ws, clients }) =>
    handleImageUploadChunk(chunk(0, 1, "abc"), ws, clients, processor, 100, 10, 100));
  await handleImageUploadChunk(chunk(0, 1, "abc"), third.ws, third.clients,
    () => assert.fail("processing must be bounded"), 100, 10, 100);
  assert.match(third.ws.messages.at(-1).error, /busy/);
  releases.forEach((resolve) => resolve({ size: 3, buffer: Buffer.from("abc"), mimeType: "image/png" }));
  await Promise.all(work);
  const failed = upload(3);
  await handleImageUploadChunk(chunk(0, 1, "abc"), failed.ws, failed.clients,
    async () => { throw new Error("decoder failed"); }, 100, 10, 100);
  assert.equal(failed.ws.imageUploadState, null);
  assert.match(failed.ws.messages.at(-1).error, /processing failed/);
});

test("invalid numeric configuration fails explicitly", () => {
  process.env.TEST_NUMERIC_LIMIT = "NaN";
  assert.throws(() => positiveInteger("TEST_NUMERIC_LIMIT", 10), /positive integer/);
  delete process.env.TEST_NUMERIC_LIMIT;
});

test("boolean configuration accepts only explicit true or false", () => {
  process.env.TEST_BOOLEAN_FLAG = "true";
  assert.equal(booleanFlag("TEST_BOOLEAN_FLAG"), true);
  process.env.TEST_BOOLEAN_FLAG = "false";
  assert.equal(booleanFlag("TEST_BOOLEAN_FLAG", true), false);
  process.env.TEST_BOOLEAN_FLAG = "yes";
  assert.throws(() => booleanFlag("TEST_BOOLEAN_FLAG"), /true or false/);
  delete process.env.TEST_BOOLEAN_FLAG;
  assert.equal(booleanFlag("TEST_BOOLEAN_FLAG"), false);
});
