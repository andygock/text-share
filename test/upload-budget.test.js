const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.MAX_BUFFERED_UPLOAD_BYTES = "5";
process.env.UPLOAD_TIMEOUT_MS = "150";

const { handleImageUploadChunk, startUpload, finishUpload } = require("../upload-handler");

function socket() {
  return { readyState: 1, bufferedAmount: 0, messages: [],
    send(data, callback) { this.messages.push(JSON.parse(data)); callback?.(); } };
}

function upload(uploadId, size = 3) {
  const ws = socket();
  const clients = new Set([ws]);
  const state = startUpload(ws, clients, { uploadId, filename: `${uploadId}.png`, size });
  return { ws, clients, state };
}

function chunk(uploadId, filename, index, total, data) {
  return { uploadId, filename, chunkIndex: index, totalChunks: total,
    data: Buffer.from(data).toString("base64") };
}

const processor = async (buffer) => ({ size: buffer.length, buffer, width: 1, height: 1, mimeType: "image/png" });

test("buffered upload budget applies globally and rejection releases earlier chunks", async () => {
  const first = upload("first", 6);
  const second = upload("second", 3);
  const afterReject = upload("after-reject");

  await handleImageUploadChunk(chunk("first", "first.png", 0, 2, "abc"),
    first.ws, first.clients, processor, 100, 10, 100);
  await handleImageUploadChunk(chunk("second", "second.png", 0, 2, "de"),
    second.ws, second.clients, processor, 100, 10, 100);
  await handleImageUploadChunk(chunk("second", "second.png", 1, 2, "f"),
    second.ws, second.clients, processor, 100, 10, 100);
  assert.equal(second.ws.imageUploadState, null);
  assert.match(second.ws.messages.at(-1).error, /buffered upload capacity/i);

  finishUpload(first.ws, first.clients, first.state);
  await handleImageUploadChunk(chunk("after-reject", "after-reject.png", 0, 1, "ghi"),
    afterReject.ws, afterReject.clients, processor, 100, 10, 100);
  assert.equal(afterReject.ws.messages.some((message) => message.type === "imageUploadComplete"), true);
});

test("identical duplicate chunks do not reserve bytes twice", async () => {
  const first = upload("duplicate", 6);
  const second = upload("blocked");
  const data = chunk("duplicate", "duplicate.png", 0, 2, "abc");

  await handleImageUploadChunk(data, first.ws, first.clients, processor, 100, 10, 100);
  await handleImageUploadChunk(data, first.ws, first.clients, processor, 100, 10, 100);
  assert.equal(first.state.reservedBytes, 3);
  await handleImageUploadChunk(chunk("blocked", "blocked.png", 0, 1, "def"),
    second.ws, second.clients, processor, 100, 10, 100);
  assert.match(second.ws.messages.at(-1).error, /buffered upload capacity/i);
  finishUpload(first.ws, first.clients, first.state);
});

test("conflicting duplicate abort releases its buffered reservation", async () => {
  const first = upload("conflict", 6);
  const next = upload("next");
  await handleImageUploadChunk(chunk("conflict", "conflict.png", 0, 2, "abc"),
    first.ws, first.clients, processor, 100, 10, 100);
  await handleImageUploadChunk(chunk("conflict", "conflict.png", 0, 2, "xyz"),
    first.ws, first.clients, processor, 100, 10, 100);
  assert.match(first.ws.messages.at(-1).error, /conflicting duplicate/i);
  await handleImageUploadChunk(chunk("next", "next.png", 0, 1, "def"),
    next.ws, next.clients, processor, 100, 10, 100);
  assert.equal(next.ws.messages.some((message) => message.type === "imageUploadComplete"), true);
});

test("processing handoff releases buffered bytes while processing remains pending", async () => {
  const pendingUpload = upload("processing");
  const next = upload("while-processing");
  let resolve;
  const pending = handleImageUploadChunk(chunk("processing", "processing.png", 0, 1, "abc"),
    pendingUpload.ws, pendingUpload.clients,
    (buffer) => new Promise((done) => { resolve = () => done({ size: buffer.length, buffer, mimeType: "image/png" }); }),
    100, 10, 100);

  await handleImageUploadChunk(chunk("while-processing", "while-processing.png", 0, 1, "def"),
    next.ws, next.clients, processor, 100, 10, 100);
  assert.equal(next.ws.messages.some((message) => message.type === "imageUploadComplete"), true);
  resolve();
  await pending;
});

test("timeout releases buffered bytes", async () => {
  const timedOut = upload("timed-out", 6);
  await handleImageUploadChunk(chunk("timed-out", "timed-out.png", 0, 2, "abc"),
    timedOut.ws, timedOut.clients, processor, 100, 10, 100);
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal(timedOut.ws.imageUploadState, null);

  const next = upload("after-timeout");
  await handleImageUploadChunk(chunk("after-timeout", "after-timeout.png", 0, 1, "def"),
    next.ws, next.clients, processor, 100, 10, 100);
  assert.equal(next.ws.messages.some((message) => message.type === "imageUploadComplete"), true);
});
