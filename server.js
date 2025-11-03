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
app.use(express.json());

const crypto = require("crypto");
const { globalJoinLimiter, ipJoinLimiter } = require("./rate-limiter");

// In-memory invite / request stores
const sockets = new Map(); // socketId -> ws
const pendingInvites = new Map(); // token -> invite
const pinToToken = new Map(); // pin -> token
const pendingRequests = new Map(); // requestId -> { res, timeout }

// Configurable invite settings
const INVITE_TTL_MS = parseInt(process.env.INVITE_TTL_MS, 10) || 30000; // 30s
const INVITE_MAX_ATTEMPTS = parseInt(process.env.INVITE_MAX_ATTEMPTS, 10) || 5;

function generateUnique6DigitPin() {
  // Try a few times to avoid collision with active pins
  for (let i = 0; i < 10; i++) {
    const pin = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0");
    if (!pinToToken.has(pin)) return pin;
  }
  // Fallback: brute force until unique
  let pin;
  do {
    pin = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0");
  } while (pinToToken.has(pin));
  return pin;
}

function expireInvite(token) {
  // centralized deletion to ensure timeouts and pending requests are cleaned up
  deleteInvite(token, "expired");
}

function deleteInvite(token, reason = "removed") {
  const invite = pendingInvites.get(token);
  if (!invite) return;
  // clear scheduled expiry if present
  if (invite.timeoutId) {
    try {
      clearTimeout(invite.timeoutId);
    } catch (e) {}
  }
  pendingInvites.delete(token);
  pinToToken.delete(invite.pin);
  // notify owner if connected
  const ownerWs = sockets.get(invite.ownerSocketId);
  if (ownerWs && ownerWs.readyState === WebSocket.OPEN) {
    try {
      ownerWs.send(
        JSON.stringify({ type: "inviteRemoved", pin: invite.pin, reason })
      );
    } catch (e) {}
  }
  // fail any pending requests for this invite
  for (const [requestId, pending] of pendingRequests.entries()) {
    if (pending.inviteToken === token) {
      try {
        pending.res.json({ ok: false, error: `Invite ${reason}` });
      } catch (e) {}
      clearTimeout(pending.timeout);
      pendingRequests.delete(requestId);
    }
  }
}

// Periodically cleanup expired invites
setInterval(() => {
  const now = Date.now();
  for (const [token, invite] of pendingInvites.entries()) {
    if (invite.expiresAt <= now) expireInvite(token);
  }
}, 30 * 1000);
// Max image upload size (default 10MB, can override with env var)
const MAX_IMAGE_UPLOAD_SIZE =
  parseInt(process.env.MAX_IMAGE_UPLOAD_SIZE_BYTES, 10) || 10 * 1024 * 1024;
// Chunking limits to prevent memory/DoS from malformed uploads
const MAX_CHUNKS = parseInt(process.env.MAX_CHUNKS || "4096", 10);
const MAX_CHUNK_BYTES = parseInt(process.env.MAX_CHUNK_BYTES || "131072", 10); // 128KB

const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_IMAGE_UPLOAD_SIZE + 1024 * 1024, // allow small margin
  perMessageDeflate: false,
});

app.get("/", (req, res) => {
  const uuid = uuidv4();
  res.redirect(`/${uuid}`);
});

app.get("/join", (req, res) => {
  res.render("join");
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

// Endpoint used by a recipient to request joining a room using a short PIN
app.post("/request-join", async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",").shift() ||
    req.socket.remoteAddress ||
    "127.0.0.1";

  // rate limit join requests
  try {
    await globalJoinLimiter.consume("global");
    await ipJoinLimiter.consume(clientIp);
  } catch (rlErr) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }

  const { pin } = req.body || {};
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ ok: false, error: "Missing pin" });
  }
  // Find invite by pin
  const token = pinToToken.get(pin);
  if (!token)
    return res.status(404).json({ ok: false, error: "No active invite" });
  const invite = pendingInvites.get(token);
  if (!invite || invite.expiresAt <= Date.now() || invite.used) {
    pinToToken.delete(pin);
    pendingInvites.delete(token);
    return res.status(404).json({ ok: false, error: "No active invite" });
  }
  // attempt counting
  if (invite.attempts >= invite.maxAttempts) {
    return res
      .status(429)
      .json({ ok: false, error: "Too many attempts for this code" });
  }
  invite.attempts++;

  // Ensure owner is connected
  const ownerWs = sockets.get(invite.ownerSocketId);
  if (!ownerWs || ownerWs.readyState !== WebSocket.OPEN) {
    return res
      .status(410)
      .json({ ok: false, error: "Invite owner not available" });
  }

  // Create a pending request and notify owner; keep the response open until owner accepts/denies or timeout
  const requestId = uuidv4();
  const timeout = setTimeout(() => {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    try {
      pending.res.json({ ok: false, error: "Timed out waiting for owner" });
    } catch (e) {}
    pendingRequests.delete(requestId);
  }, Math.min(invite.expiresAt - Date.now(), 120000));

  pendingRequests.set(requestId, { res, timeout, inviteToken: token });
  // Notify owner of the join request
  try {
    ownerWs.send(
      JSON.stringify({
        type: "joinRequest",
        requestId,
        requesterIP: clientIp,
        ua: req.headers["user-agent"] || "",
      })
    );
  } catch (err) {
    clearTimeout(timeout);
    pendingRequests.delete(requestId);
    return res.status(500).json({ ok: false, error: "Failed to notify owner" });
  }
  // do not end response here - it will be fulfilled when owner calls respondInvite via WS
});

wss.on("connection", (ws, req) => {
  // assign an id for this socket so it can be referenced from invite flows
  ws.id = uuidv4();
  sockets.set(ws.id, ws);
  // Parse and validate roomId from the connection URL (ignore querystring)
  const rawPath = (req.url || "/").split("?")[0] || "/";
  const roomId = decodeURIComponent(
    rawPath.startsWith("/") ? rawPath.substring(1) : rawPath
  );
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(roomId)) {
    try {
      ws.close(1008, "Invalid room ID");
    } catch (e) {}
    return;
  }
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

  // WS-level invite messages
  // Supported messages: generateInvite, respondInvite

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
      // INVITE: owner wants to generate a short PIN for this room
      if (parsed.type === "generateInvite") {
        // Only allow if this ws is in a room (roomId) and is actually part of that room
        // Create invite object
        try {
          const pin = generateUnique6DigitPin();
          const token = crypto.randomBytes(16).toString("hex");
          const invite = {
            token,
            roomId,
            pin,
            createdAt: Date.now(),
            expiresAt: Date.now() + INVITE_TTL_MS,
            ownerSocketId: ws.id,
            attempts: 0,
            maxAttempts: INVITE_MAX_ATTEMPTS,
            used: false,
          };
          // If this owner already has an active invite, remove it (only one invite per client)
          for (const [
            existingToken,
            existingInvite,
          ] of pendingInvites.entries()) {
            if (existingInvite.ownerSocketId === ws.id) {
              deleteInvite(existingToken, "replaced");
            }
          }

          // store invite and schedule expiry (keep timeout id so we can clear on replace)
          const timeoutId = setTimeout(
            () => expireInvite(token),
            INVITE_TTL_MS + 1000
          );
          invite.timeoutId = timeoutId;
          pendingInvites.set(token, invite);
          pinToToken.set(pin, token);
          // Respond to owner with pin
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "inviteGenerated",
                pin: invite.pin,
                expiresAt: invite.expiresAt,
              })
            );
          }
        } catch (err) {
          console.error("Failed to generate invite", err);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "inviteError",
                error: "Failed to generate invite",
              })
            );
          }
        }
        return;
      }

      // Owner responds to a pending join request
      if (parsed.type === "respondInvite") {
        const { requestId, accept } = parsed;
        const pending = pendingRequests.get(requestId);
        if (!pending) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "respondInviteError",
                error: "Unknown or expired request",
              })
            );
          }
          return;
        }
        const { inviteToken } = pending;
        const invite = pendingInvites.get(inviteToken);
        if (!invite) {
          // invite expired
          pending.res.json({ ok: false, error: "Invite expired" });
          clearTimeout(pending.timeout);
          pendingRequests.delete(requestId);
          return;
        }
        // Only the owner can respond
        if (invite.ownerSocketId !== ws.id) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "respondInviteError",
                error: "Not authorized",
              })
            );
          }
          return;
        }
        if (accept) {
          invite.used = true;
          // respond to pending HTTP request with room URL so the requester can redirect
          pending.res.json({ ok: true, roomUrl: `/${invite.roomId}` });
        } else {
          pending.res.json({ ok: false, error: "Denied by owner" });
        }
        clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
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
          ws.imageUploadState.received =
            (ws.imageUploadState.received || 0) + 1;
        } else {
          // overwrite duplicate
          ws.imageUploadState.chunks[chunkIndex] = parsed.data;
        }
        ws.imageUploadState.totalChunks = totalChunks;

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
    sockets.delete(ws.id);
    // Remove any invites owned by this socket and fail pending requests
    for (const [token, invite] of pendingInvites.entries()) {
      if (invite.ownerSocketId === ws.id) {
        deleteInvite(token, "owner_disconnected");
      }
    }
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
