// Handles imageUploadChunk validation and final assembly/processing.
const path = require("path");
const { sendJson } = require("./socket-utils");
const { positiveInteger } = require("./config");
const MAX_PROCESSING = positiveInteger("MAX_IMAGE_PROCESSING", 2);
const UPLOAD_TIMEOUT_MS = positiveInteger("UPLOAD_TIMEOUT_MS", 60000);
let processingCount = 0;

function finishUpload(ws, clients, state, error) {
  clearTimeout(state.timeout);
  if (ws.imageUploadState === state) {
    ws.imageUploadState = null;
  }
  state.cancelled = true;
  state.chunks = [];
  if (error) {
    for (const client of clients) {
      sendJson(client, { type: "imageUploadError", uploadId: state.uploadId, filename: state.filename, error });
    }
  }
}

function startUpload(ws, clients, metadata) {
  const state = { ...metadata, chunks: [], received: 0, receivedBytes: 0, totalChunks: null, processing: false };
  ws.imageUploadState = state;
  state.timeout = setTimeout(() => finishUpload(ws, clients, state, "Upload timed out."), UPLOAD_TIMEOUT_MS);
  return state;
}

async function handleImageUploadChunk(parsed, ws, roomClients, processImageBuffer, maxSize, maxChunks, maxChunkBytes) {
  const state = ws.imageUploadState;
  if (!state || state.processing || parsed.uploadId !== state.uploadId) {
    return;
  }
  const fail = (error) => finishUpload(ws, roomClients, state, error);
  const { chunkIndex, totalChunks, data } = parsed;

  // Decode chunks independently so padding cannot truncate the assembled file.
  if (parsed.filename !== state.filename || !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > maxChunks ||
      chunkIndex < 0 || chunkIndex >= totalChunks ||
      (state.totalChunks !== null && state.totalChunks !== totalChunks) ||
      typeof data !== "string" || !data || data.length > Math.ceil(maxChunkBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    return fail("Invalid upload chunk.");
  }
  const chunk = Buffer.from(data, "base64");
  if (chunk.length > maxChunkBytes || chunk.toString("base64") !== data) {
    return fail("Invalid chunk encoding or size.");
  }

  // Identical retransmissions are harmless; conflicting duplicates abort.
  if (state.chunks[chunkIndex]) {
    if (!state.chunks[chunkIndex].equals(chunk)) {
      fail("Conflicting duplicate chunk.");
    }
    return;
  }
  state.receivedBytes += chunk.length;
  if (state.receivedBytes > maxSize || state.receivedBytes > state.size) {
    return fail("Upload exceeds declared or allowed size.");
  }
  state.chunks[chunkIndex] = chunk;
  state.received++;
  state.totalChunks = totalChunks;
  for (const client of roomClients) {
    sendJson(client, { type: "imageUploadProgress", uploadId: state.uploadId, filename: state.filename,
      progress: Math.round(state.received / totalChunks * 100) });
  }
  if (state.received !== totalChunks) {
    return;
  }
  if (state.receivedBytes !== state.size) {
    return fail("Upload size does not match its declaration.");
  }
  if (processingCount >= MAX_PROCESSING) {
    return fail("Image processing is busy. Please retry shortly.");
  }

  // Lock before awaiting native processing and retain this specific upload.
  state.processing = true;
  processingCount++;
  try {
    const buffer = Buffer.concat(state.chunks, state.receivedBytes);
    state.chunks = [];
    const result = await processImageBuffer(buffer, path.extname(state.filename).toLowerCase());
    if (state.cancelled || ws.readyState !== 1) {
      return;
    }
    if (result.size > 500 * 1024) {
      return fail("Image could not be compressed below 500 KiB.");
    }
    for (const client of roomClients) {
      sendJson(client, { type: "imageUploadComplete", uploadId: state.uploadId, filename: state.filename,
        mimeType: result.mimeType, width: result.width, height: result.height,
        size: result.size, data: result.buffer.toString("base64") });
    }
  } catch {
    if (!state.cancelled) {
      fail("Image processing failed.");
    }
  } finally {
    processingCount--;
    finishUpload(ws, roomClients, state);
  }
}

module.exports = { handleImageUploadChunk, startUpload, finishUpload };
