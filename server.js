// server.js
require("dotenv").config(); // Load .env variables
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { processImageBuffer } = require("./image-handler");
const {
  rooms,
  getOrCreateRoom,
  canJoinRoom,
  joinRoom,
  leaveRoom,
} = require("./room-manager");

// --- Rate limiting for image uploads and text input ---
const {
  globalUploadLimiter,
  ipUploadLimiter,
  globalTextLimiter,
  ipTextLimiter,
} = require("./rate-limiter");

const app = express();

app.set("view engine", "ejs");
app.use(express.static("public")); // Serve static files from 'public' directory

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Max image upload size (default 10MB, can override with env var)
const MAX_IMAGE_UPLOAD_SIZE =
  parseInt(process.env.MAX_IMAGE_UPLOAD_SIZE_BYTES, 10) || 10 * 1024 * 1024;

app.get("/", (req, res) => {
  const uuid = uuidv4();
  res.redirect(`/${uuid}`);
});

app.get("/:roomId", (req, res) => {
  const roomId = req.params.roomId;
  // Basic UUID validation (more robust validation can be added if needed)
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      roomId
    )
  ) {
    return res.status(400).send("Invalid room ID format.");
  }
  res.render("index", { roomId, maxImageUploadSize: MAX_IMAGE_UPLOAD_SIZE });
});

wss.on("connection", (ws, req) => {
  const roomId = req.url.substring(1); // URL after / is the roomId
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",").shift() ||
    req.socket.remoteAddress ||
    "127.0.0.1";

  const joinCheck = canJoinRoom(roomId, clientIp);
  if (!joinCheck.allowed) {
    ws.close(1008, joinCheck.reason);
    return;
  }

  joinRoom(roomId, ws, clientIp);
  const roomClients = getOrCreateRoom(roomId);

  console.log(`Client connected to room ${roomId} from IP: ${clientIp}`);
  console.log(`Current clients in room ${roomId}: ${roomClients.size}`);

  // Send current user list to the newly connected client
  const userList = Array.from(roomClients).map((client) => client.ip);
  ws.send(JSON.stringify({ type: "userList", users: userList }));

  // Notify other clients of new connection
  roomClients.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "userConnected", ip: clientIp }));
    }
  });

  ws.ip = clientIp;

  ws.on("message", async (message, isBinary) => {
    // Handle text messages as before
    if (!isBinary) {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        // Ignore non-JSON messages
        return;
      }
      // Handle protocol messages
      if (parsed.type === "textUpdate") {
        // --- Rate limiting for text updates ---
        try {
          await globalTextLimiter.consume("global");
          await ipTextLimiter.consume(clientIp);
        } catch (rateErr) {
          ws.send(
            JSON.stringify({
              type: "textUpdateError",
              error: "Text update rate limit exceeded. Please try again later.",
            })
          );
          return;
        }
        // Broadcast to all other clients
        roomClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({ type: "textUpdate", text: parsed.text })
            );
          }
        });
        return;
      }
      // Handle image protocol
      if (parsed.type === "imageUploadStart") {
        // Only allow one upload at a time per connection
        if (ws.imageUploadState) {
          ws.send(
            JSON.stringify({
              type: "imageUploadError",
              filename: parsed.filename,
              error:
                "Only one file upload is allowed at a time. Please wait for the current upload to finish.",
            })
          );
          return;
        }
        // Rate limiting for image uploads
        try {
          await globalUploadLimiter.consume("global");
          await ipUploadLimiter.consume(clientIp);
        } catch (rateErr) {
          ws.send(
            JSON.stringify({
              type: "imageUploadError",
              filename: parsed.filename,
              error: "Upload rate limit exceeded. Please try again later.",
            })
          );
          return;
        }
        // Check upload size
        if (parsed.size > MAX_IMAGE_UPLOAD_SIZE) {
          ws.send(
            JSON.stringify({
              type: "imageUploadError",
              filename: parsed.filename,
              error: `File too large. Max allowed is ${Math.floor(
                MAX_IMAGE_UPLOAD_SIZE / 1024 / 1024
              )}MB. Your file is ${(parsed.size / 1024 / 1024).toFixed(2)}MB.`,
            })
          );
          return;
        }
        // Initialize upload state
        ws.imageUploadState = {
          filename: parsed.filename,
          mimeType: parsed.mimeType,
          size: parsed.size,
          chunks: [],
          received: 0,
          totalChunks: null,
        };
        // Broadcast start to all clients (including uploader)
        roomClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "imageUploadStart",
                filename: parsed.filename,
                mimeType: parsed.mimeType,
                size: parsed.size,
              })
            );
          }
        });
      } else if (parsed.type === "imageUploadChunk") {
        if (!ws.imageUploadState) return;
        ws.imageUploadState.chunks[parsed.chunkIndex] = parsed.data;
        ws.imageUploadState.received++;
        ws.imageUploadState.totalChunks = parsed.totalChunks;
        // Broadcast chunk to all clients (including uploader)
        roomClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        });
        // Progress
        const progress = Math.round(
          (ws.imageUploadState.received / ws.imageUploadState.totalChunks) * 100
        );
        roomClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
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
            // Reassemble base64 chunks
            const base64 = ws.imageUploadState.chunks.join("");
            const buffer = Buffer.from(base64, "base64");
            const ext = require("path")
              .extname(ws.imageUploadState.filename)
              .toLowerCase();
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
              if (client.readyState === WebSocket.OPEN) {
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
      return;
    }
  });

  ws.on("close", () => {
    const roomIsEmpty = leaveRoom(roomId, ws, clientIp);
    console.log(`Client disconnected from room ${roomId} from IP: ${clientIp}`);
    console.log(
      `Remaining clients in room ${roomId}: ${getOrCreateRoom(roomId).size}`
    );
    // Notify other clients of disconnection
    const currentRoomClients = rooms.get(roomId) || [];
    currentRoomClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "userDisconnected", ip: clientIp }));
      }
    });
    if (roomIsEmpty) {
      console.log(`Room ${roomId} is empty.`);
      // cleanupRoomImages(roomId); // Removed as requested
    }
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error in room ${roomId}:`, error);
    leaveRoom(roomId, ws, clientIp);
    if ((rooms.get(roomId) || []).size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
