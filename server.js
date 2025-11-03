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
const invites = require("./invites");
const { handleImageUploadChunk } = require("./upload-handler");

// In-memory invite / request stores
const sockets = new Map(); // socketId -> ws
// invites.pendingInvites, invites.pinToToken and invites.pendingRequests are used instead of local maps

// Configurable invite settings
const INVITE_TTL_MS = parseInt(process.env.INVITE_TTL_MS, 10) || 30000; // 30s
const INVITE_MAX_ATTEMPTS = parseInt(process.env.INVITE_MAX_ATTEMPTS, 10) || 5;

// use invites.generateUnique6DigitPin when needed
// use invites.deleteInvite / invites.expireInvite

// Periodically cleanup expired invites
setInterval(() => {
  const now = Date.now();
  for (const [token, invite] of invites.pendingInvites.entries()) {
    if (invite.expiresAt <= now) {
      invites.expireInvite(token, sockets);
    }
  }
}, 30 * 1000);

// Max image upload size (default 10MB, can override with env var)
const MAX_IMAGE_UPLOAD_SIZE =
  parseInt(process.env.MAX_IMAGE_UPLOAD_SIZE_BYTES, 10) || 10 * 1024 * 1024;

// Chunking limits to prevent memory/DoS from malformed uploads
const MAX_CHUNKS = parseInt(process.env.MAX_CHUNKS || "4096", 10);
const MAX_CHUNK_BYTES = parseInt(process.env.MAX_CHUNK_BYTES || "131072", 10); // 128KB

const server = http.createServer(app);

// Create a WebSocket server without attaching to the HTTP server so we can
// verify the Origin header on upgrade requests.
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: MAX_IMAGE_UPLOAD_SIZE + 1024 * 1024, // allow small margin
  perMessageDeflate: false,
});

// Allowed origins can be configured via ALLOWED_ORIGINS env var as a comma-separated list.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : null;

// Helper to check origin. If allowedOrigins is set, only allow those. Otherwise allow same-origin (host match).
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  } // non-browser or no origin header
  if (allowedOrigins && allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin);
  }

  // Fallback: allow same-origin (protocol + host)
  const host = req.headers.host;
  if (!host) {
    return false;
  }
  const expected = `${req.socket.encrypted ? "https" : "http"}://${host}`;
  return origin === expected;
}

// Handle HTTP Upgrade to WebSocket and perform Origin checks
server.on("upgrade", (req, socket, head) => {
  try {
    if (!isOriginAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      console.warn(
        "WebSocket upgrade rejected due to Origin:",
        req.headers.origin
      );
      return;
    }

    // We can allow the upgrade; delegate to the WebSocket server
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (err) {
    console.error("Error during upgrade handling:", err);
    try {
      socket.destroy();
    } catch (e) {}
  }
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
  const token = invites.pinToToken.get(pin);
  if (!token) {
    return res.status(404).json({ ok: false, error: "No active invite" });
  }

  const invite = invites.pendingInvites.get(token);
  if (!invite || invite.expiresAt <= Date.now() || invite.used) {
    invites.pinToToken.delete(pin);
    invites.pendingInvites.delete(token);
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
    const pending = invites.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    try {
      pending.res.json({ ok: false, error: "Timed out waiting for owner" });
    } catch (e) {}
    invites.pendingRequests.delete(requestId);
  }, Math.min(invite.expiresAt - Date.now(), 120000));

  invites.pendingRequests.set(requestId, { res, timeout, inviteToken: token });

  console.info(
    `invite: join-request id=${requestId} token=${token} from=${clientIp} ua=${(
      req.headers["user-agent"] || ""
    ).slice(0, 200)}`
  );

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
    console.info(
      `invite: notified owner ${invite.ownerSocketId} of request ${requestId}`
    );
  } catch (err) {
    clearTimeout(timeout);
    invites.pendingRequests.delete(requestId);
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

  console.log(
    `Client connected: id=${ws.id} room=${roomId} ip=${clientIp} clients=${roomClients.size}`
  );

  // Send current user list to the newly connected client
  const userList = Array.from(roomClients).map(
    (client) => client.ip || client._socket?.remoteAddress || "unknown"
  );
  ws.send(JSON.stringify({ type: "userList", users: userList }));

  // Notify other clients of new connection
  roomClients.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "userConnected", ip: clientIp }));
    }
  });

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
          const pin = invites.generateUnique6DigitPin();
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
          ] of invites.pendingInvites.entries()) {
            if (existingInvite.ownerSocketId === ws.id) {
              invites.deleteInvite(existingToken, "replaced", sockets);
            }
          }

          // store invite and schedule expiry (keep timeout id so we can clear on replace)
          const timeoutId = setTimeout(
            () => invites.expireInvite(token, sockets),
            INVITE_TTL_MS + 1000
          );
          invite.timeoutId = timeoutId;
          invites.pendingInvites.set(token, invite);
          invites.pinToToken.set(pin, token);
          console.info(
            `invite: generated token=${token} pin=${pin} owner=${ws.id} room=${roomId} expiresAt=${invite.expiresAt}`
          );

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
        const pending = invites.pendingRequests.get(requestId);
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
        const invite = invites.pendingInvites.get(inviteToken);
        if (!invite) {
          // invite expired
          pending.res.json({ ok: false, error: "Invite expired" });
          clearTimeout(pending.timeout);
          invites.pendingRequests.delete(requestId);
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
          console.info(
            `invite: accepted requestId=${requestId} token=${inviteToken} owner=${ws.id}`
          );
        } else {
          pending.res.json({ ok: false, error: "Denied by owner" });
          console.info(
            `invite: denied requestId=${requestId} token=${inviteToken} owner=${ws.id}`
          );
        }
        clearTimeout(pending.timeout);
        invites.pendingRequests.delete(requestId);
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
        // Basic validation to avoid DoS via malformed chunk messages before delegating to handler
        const chunkIndex = Number(parsed.chunkIndex);
        const totalChunks = Number(parsed.totalChunks);
        const data = parsed.data || "";

        if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
          ws.send(
            JSON.stringify({
              type: "imageUploadError",
              filename: parsed.filename,
              error: "Invalid chunk index",
            })
          );
          return;
        }
        if (
          !Number.isFinite(totalChunks) ||
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

        // Estimate decoded byte length from base64 string length: bytes ~= (len * 3) / 4
        const base64Len = typeof data === "string" ? data.length : 0;
        const estimatedBytes = Math.floor((base64Len * 3) / 4);
        if (estimatedBytes > MAX_CHUNK_BYTES) {
          ws.send(
            JSON.stringify({
              type: "imageUploadError",
              filename: parsed.filename,
              error: "Chunk too large",
            })
          );
          return;
        }

        // delegate to upload handler
        try {
          await handleImageUploadChunk(
            parsed,
            ws,
            roomClients,
            processImageBuffer,
            MAX_IMAGE_UPLOAD_SIZE,
            MAX_CHUNKS,
            MAX_CHUNK_BYTES
          );
        } catch (err) {
          console.error("upload chunk handler error", err);
          try {
            ws.send(
              JSON.stringify({
                type: "imageUploadError",
                filename: parsed.filename,
                error: "Server error processing chunk",
              })
            );
          } catch (e) {}
          ws.imageUploadState = null;
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    sockets.delete(ws.id);

    // Remove any invites owned by this socket and fail pending requests
    for (const [token, invite] of invites.pendingInvites.entries()) {
      if (invite.ownerSocketId === ws.id) {
        invites.deleteInvite(token, "owner_disconnected", sockets);
      }
    }
    const roomIsEmpty = leaveRoom(roomId, ws, clientIp);
    console.log(
      `Client disconnected: id=${ws.id} room=${roomId} ip=${clientIp}`
    );
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
