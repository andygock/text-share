// upload-handler.js
// Handles imageUploadChunk validation and final assembly/processing

const path = require("path");

async function handleImageUploadChunk(
  parsed,
  ws,
  roomClients,
  processImageBuffer,
  MAX_IMAGE_UPLOAD_SIZE,
  MAX_CHUNKS,
  MAX_CHUNK_BYTES
) {
  if (!ws.imageUploadState) return;
  // Basic filename match
  if (parsed.filename !== ws.imageUploadState.filename) {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Mismatched filename for upload",
      })
    );
    return;
  }
  // Validate indexes and sizes to avoid DoS/memory exhaustion
  const chunkIndex = Number(parsed.chunkIndex);
  const totalChunks = Number(parsed.totalChunks);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Invalid chunkIndex",
      })
    );
    return;
  }
  if (
    !Number.isInteger(totalChunks) ||
    totalChunks <= 0 ||
    totalChunks > MAX_CHUNKS
  ) {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Invalid totalChunks",
      })
    );
    return;
  }
  if (!parsed.data || typeof parsed.data !== "string") {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Missing chunk data",
      })
    );
    return;
  }
  // Approximate chunk bytes when base64-decoded
  const approxBytes = Buffer.byteLength(parsed.data, "base64");
  if (approxBytes > MAX_CHUNK_BYTES) {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Chunk too large",
      })
    );
    return;
  }
  // Rough estimate of total upload size
  const estimatedTotal = approxBytes * totalChunks;
  if (estimatedTotal > MAX_IMAGE_UPLOAD_SIZE * 1.2) {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Upload exceeds allowed size",
      })
    );
    ws.imageUploadState = null;
    return;
  }

  // Prevent creating extremely sparse arrays
  if (totalChunks > MAX_CHUNKS) {
    ws.send(
      JSON.stringify({
        type: "imageUploadError",
        filename: parsed.filename,
        error: "Too many chunks",
      })
    );
    ws.imageUploadState = null;
    return;
  }

  // Store chunk (do not double-count if re-sent)
  if (!ws.imageUploadState.chunks[chunkIndex]) {
    ws.imageUploadState.chunks[chunkIndex] = parsed.data;
    ws.imageUploadState.received = (ws.imageUploadState.received || 0) + 1;
  } else {
    // overwrite duplicate
    ws.imageUploadState.chunks[chunkIndex] = parsed.data;
  }
  ws.imageUploadState.totalChunks = totalChunks;

  // Broadcast chunk to all clients (including uploader)
  roomClients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(parsed));
    }
  });

  // Progress
  const progress = Math.round(
    (ws.imageUploadState.received / ws.imageUploadState.totalChunks) * 100
  );
  roomClients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(
        JSON.stringify({
          type: "imageUploadProgress",
          filename: ws.imageUploadState.filename,
          progress,
        })
      );
    }
  });

  // If last chunk, process image
  if (ws.imageUploadState.received === ws.imageUploadState.totalChunks) {
    try {
      const base64 = ws.imageUploadState.chunks.join("");
      const buffer = Buffer.from(base64, "base64");
      const ext = path.extname(ws.imageUploadState.filename).toLowerCase();
      const result = await processImageBuffer(buffer, ext);
      if (result.size > 500 * 1024) {
        ws.send(
          JSON.stringify({
            type: "imageUploadError",
            filename: ws.imageUploadState.filename,
            error: "Image could not be compressed below 500kB.",
          })
        );
        ws.imageUploadState = null;
        return;
      }
      // Send complete to all
      roomClients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(
            JSON.stringify({
              type: "imageUploadComplete",
              filename: ws.imageUploadState.filename,
              mimeType: ws.imageUploadState.mimeType,
              width: result.width,
              height: result.height,
              size: result.size,
              data: result.buffer.toString("base64"),
            })
          );
        }
      });
      ws.imageUploadState = null;
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "imageUploadError",
          filename: ws.imageUploadState.filename,
          error: "Image processing failed.",
        })
      );
      ws.imageUploadState = null;
    }
  }
}

module.exports = { handleImageUploadChunk };
