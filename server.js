// server.js
require("dotenv").config(); // Load .env variables

const express = require("express");
const helmet = require("helmet");
const http = require("http");
const net = require("net");
const { positiveInteger } = require("./config");
const { sendJson } = require("./socket-utils");
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

const TRUSTED_PROXY_IPS = (process.env.TRUSTED_PROXY_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

if (TRUSTED_PROXY_IPS.length > 0) {
  app.set("trust proxy", TRUSTED_PROXY_IPS);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "base-uri": ["'self'"],
        "connect-src": ["'self'", "ws:", "wss:"],
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  })
);

app.use(express.static("public")); // Serve static files from 'public' directory
app.use(express.json({ limit: "16kb" }));

const crypto = require("crypto");
const { globalJoinLimiter, ipJoinLimiter } = require("./rate-limiter");
const invites = require("./invites");
const { handleImageUploadChunk, startUpload, finishUpload } = require("./upload-handler");

// In-memory invite / request stores
const sockets = new Map(); // socketId -> ws
// invites.pendingInvites, invites.pinToToken and invites.pendingRequests are used instead of local maps

// Configurable invite settings
const INVITE_TTL_MS = positiveInteger("INVITE_TTL_MS", 30000); // 30s
const INVITE_MAX_ATTEMPTS = positiveInteger("INVITE_MAX_ATTEMPTS", 5);

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
  positiveInteger("MAX_IMAGE_UPLOAD_SIZE_BYTES", 10 * 1024 * 1024);

// Chunking limits to prevent memory/DoS from malformed uploads
const MAX_CHUNKS = positiveInteger("MAX_CHUNKS", 4096);
const MAX_CHUNK_BYTES = positiveInteger("MAX_CHUNK_BYTES", 131072); // 128KB
const MAX_TEXT_BYTES = positiveInteger("MAX_TEXT_BYTES", 65536);
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") {
    return "";
  }
  if (ip.startsWith("::ffff:")) {
    return ip.substring(7);
  }
  return ip;
}

// Apply Express's trusted-hop policy to both HTTP and upgrade requests.
function isTrustedProxy(ip) {
  const trust = app.get("trust proxy fn");
  return Boolean(trust && trust(ip, 0));
}

function getClientIp(req) {
  let address = normalizeIp(req.socket.remoteAddress);
  const trust = app.get("trust proxy fn");
  const forwarded = typeof req.headers["x-forwarded-for"] === "string"
    ? req.headers["x-forwarded-for"].split(",").map((ip) => ip.trim()).reverse() : [];
  for (let i = 0; i < forwarded.length; i++) {
    if (!trust || !trust(address, i) || !net.isIP(forwarded[i])) {
      break;
    }
    address = normalizeIp(forwarded[i]);
  }
  return address;
}

const server = http.createServer(app);

// Create a WebSocket server without attaching to the HTTP server so we can
// verify the Origin header on upgrade requests.
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: Math.max(MAX_TEXT_BYTES * 6, Math.ceil(MAX_CHUNK_BYTES / 3) * 4) + 4096, // JSON escaping and metadata
  perMessageDeflate: false,
});

// Allowed origins can be configured via ALLOWED_ORIGINS env var as a comma-separated list.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

for (const origin of allowedOrigins || []) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
    throw new Error("ALLOWED_ORIGINS must contain HTTP(S) origins without paths");
  }
}

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
  const forwardedProtocol = isTrustedProxy(req.socket.remoteAddress) ? req.headers["x-forwarded-proto"] : null;
  const protocol = forwardedProtocol === "https" ? "https" : req.socket.encrypted ? "https" : "http";
  const expected = `${protocol}://${host}`;
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
  const clientIp = getClientIp(req);

  // rate limit join requests
  try {
    await ipJoinLimiter.consume(clientIp);
    await globalJoinLimiter.consume("global");
  } catch (rlErr) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }

  const { pin } = req.body || {};
  if (typeof pin !== "string" || !/^[0-9]{6}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: "Missing pin" });
  }

  // Find invite by pin
  const token = invites.pinToToken.get(pin);
  if (!token) {
    return res.status(404).json({ ok: false, error: "No active invite" });
  }

  const invite = invites.pendingInvites.get(token);
  if (!invite || invite.expiresAt <= Date.now() || invite.used) {
    invites.deleteInvite(token, "expired", sockets);
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
  res.on("close", () => {
    clearTimeout(timeout);
    invites.pendingRequests.delete(requestId);
    sendJson(ownerWs, { type: "joinRequestRemoved", requestId });
  });

  console.info(
    `invite: join-request id=${requestId}`
  );

  // Notify owner of the join request
  try {
    const notified = sendJson(ownerWs, {
        type: "joinRequest",
        requestId,
        requesterIP: clientIp,
        ua: req.headers["user-agent"] || "",
      });
    if (!notified) { throw new Error("Owner disconnected"); }
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

  // Install safety handlers before any validation can reject this socket.
  ws.on("error", () => ws.terminate());
  ws.on("close", () => sockets.delete(ws.id));
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // Parse and validate roomId from the connection URL (ignore querystring)
  const rawPath = (req.url || "/").split("?")[0] || "/";
  let roomId;
  try {
    roomId = decodeURIComponent(rawPath.startsWith("/") ? rawPath.substring(1) : rawPath).toLowerCase();
  } catch {
    ws.close(1008, "Invalid room ID");
    return;
  }
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(roomId)) {
    try {
      ws.close(1008, "Invalid room ID");
    } catch (e) {}
    return;
  }
  const clientIp = getClientIp(req);

  const joinCheck = canJoinRoom(roomId, clientIp);
  if (!joinCheck.allowed) {
    ws.close(1008, joinCheck.reason);
    return;
  }

  joinRoom(roomId, ws, clientIp);
  sockets.set(ws.id, ws);
  const roomClients = getOrCreateRoom(roomId);

  console.log(
    `Client connected: id=${ws.id} clients=${roomClients.size}`
  );

  // Send current user list to the newly connected client
  const userList = Array.from(roomClients).map(
    (client) => client.ip || client._socket?.remoteAddress || "unknown"
  );
  sendJson(ws, { type: "userList", users: userList });
  roomClients.textState ||= { text: "", revision: 0 };
  sendJson(ws, { type: "textSnapshot", ...roomClients.textState, maxTextBytes: MAX_TEXT_BYTES });

  // Notify other clients of new connection
  roomClients.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      sendJson(client, { type: "userConnected", ip: clientIp });
    }
  });

  // WS-level invite messages
  // Supported messages: generateInvite, respondInvite

  async function handleMessage(message, isBinary) {
    // Handle text messages as before
    if (!isBinary) {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        // Ignore non-JSON messages
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
        sendJson(ws, { type: "protocolError", error: "Expected a message object." });
        return;
      }

      // Handle protocol messages
      if (parsed.type === "textUpdate") {
        if (
          typeof parsed.text !== "string" || !Number.isSafeInteger(parsed.baseRevision) ||
          typeof parsed.updateId !== "string" || parsed.updateId.length > 100 ||
          Buffer.byteLength(parsed.text, "utf8") > MAX_TEXT_BYTES
        ) {
          sendJson(ws, {
              type: "textUpdateError",
              error: `Text update exceeds ${MAX_TEXT_BYTES} bytes.`,
            });
          return;
        }

        // --- Rate limiting for text updates ---
        try {
          await ipTextLimiter.consume(clientIp);
          await globalTextLimiter.consume("global");
        } catch (rateErr) {
          sendJson(ws, {
              type: "textUpdateError",
              error: "Text update rate limit exceeded. Please try again later.",
              retryAfterMs: Math.max(1000, rateErr.msBeforeNext || 1000),
            });
          return;
        }

        if (ws.readyState !== WebSocket.OPEN) { return; }
        if (parsed.baseRevision !== roomClients.textState.revision) {
          sendJson(ws, { type: "textConflict", ...roomClients.textState });
          return;
        }
        roomClients.textState = { text: parsed.text, revision: roomClients.textState.revision + 1 };

        // Echo the accepted revision to its sender as a delivery acknowledgement.
        roomClients.forEach((client) => sendJson(client, { type: "textUpdate",
          ...roomClients.textState, updateId: client === ws ? parsed.updateId : null }));
        return;
      }

      // INVITE: owner wants to generate a short PIN for this room
      if (parsed.type === "generateInvite") {
        if (Date.now() - (ws.lastInviteAt || 0) < 1000) { return; }
        ws.lastInviteAt = Date.now();

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
            INVITE_TTL_MS
          );
          invite.timeoutId = timeoutId;
          invites.pendingInvites.set(token, invite);
          invites.pinToToken.set(pin, token);
          console.info(
            `invite: generated owner=${ws.id}`
          );

          // Respond to owner with pin
          if (ws.readyState === WebSocket.OPEN) {
            sendJson(ws, {
                type: "inviteGenerated",
                pin: invite.pin,
                expiresAt: invite.expiresAt,
              });
          }
        } catch (err) {
          console.error("Failed to generate invite", err);
          if (ws.readyState === WebSocket.OPEN) {
            sendJson(ws, {
                type: "inviteError",
                error: "Failed to generate invite",
              });
          }
        }
        return;
      }

      // Owner responds to a pending join request
      if (parsed.type === "respondInvite") {
        const { requestId, accept } = parsed;
        if (typeof requestId !== "string" || typeof accept !== "boolean") { return; }
        const pending = invites.pendingRequests.get(requestId);
        if (!pending) {
          if (ws.readyState === WebSocket.OPEN) {
            sendJson(ws, {
                type: "respondInviteError",
                error: "Unknown or expired request",
              });
          }
          return;
        }
        const { inviteToken } = pending;
        const invite = invites.pendingInvites.get(inviteToken);
        if (!invite || invite.used || invite.expiresAt <= Date.now()) {
          // invite expired
          pending.res.json({ ok: false, error: "Invite expired" });
          clearTimeout(pending.timeout);
          invites.pendingRequests.delete(requestId);
          return;
        }

        // Only the owner can respond
        if (invite.ownerSocketId !== ws.id) {
          if (ws.readyState === WebSocket.OPEN) {
            sendJson(ws, {
                type: "respondInviteError",
                error: "Not authorized",
              });
          }
          return;
        }
        if (accept) {
          invite.used = true;

          // respond to pending HTTP request with room URL so the requester can redirect
          pending.res.json({ ok: true, roomUrl: `/${invite.roomId}` });
          console.info(
            `invite: accepted requestId=${requestId} owner=${ws.id}`
          );
        } else {
          pending.res.json({ ok: false, error: "Denied by owner" });
          console.info(
            `invite: denied requestId=${requestId} token=${inviteToken} owner=${ws.id}`
          );
        }
        clearTimeout(pending.timeout);
        invites.pendingRequests.delete(requestId);
        if (accept) { invites.deleteInvite(inviteToken, "used", sockets); }
        return;
      }

      // Handle image protocol
      if (parsed.type === "imageUploadCancel") {
        if (ws.imageUploadState?.uploadId === parsed.uploadId) {
          finishUpload(ws, roomClients, ws.imageUploadState, "Upload cancelled.");
        }
        return;
      }
      if (parsed.type === "imageUploadStart") {
        const uploadSize = Number(parsed.size);
        const filename =
          typeof parsed.filename === "string" ? parsed.filename : "";
        const mimeType =
          typeof parsed.mimeType === "string" ? parsed.mimeType : "";
        const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();

        if (
          typeof parsed.uploadId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(parsed.uploadId) ||
          !filename ||
          filename.length > 255 ||
          !Number.isSafeInteger(uploadSize) ||
          uploadSize <= 0 ||
          !ALLOWED_IMAGE_MIME_TYPES.has(mimeType) ||
          !ALLOWED_IMAGE_EXTENSIONS.has(ext)
        ) {
          sendJson(ws, {
              type: "imageUploadError",
              uploadId: parsed.uploadId,
              filename,
              error: "Invalid image upload metadata",
            });
          return;
        }

        // Only allow one upload at a time per connection
        if (ws.imageUploadState) {
          sendJson(ws, {
              type: "imageUploadError",
              uploadId: parsed.uploadId,
              filename: parsed.filename,
              error:
                "Only one file upload is allowed at a time. Please wait for the current upload to finish.",
            });
          return;
        }

        // Rate limiting for image uploads
        try {
          await ipUploadLimiter.consume(clientIp);
          await globalUploadLimiter.consume("global");
        } catch (rateErr) {
          sendJson(ws, {
              type: "imageUploadError",
              uploadId: parsed.uploadId,
              filename: parsed.filename,
              error: "Upload rate limit exceeded. Please try again later.",
            });
          return;
        }

        // Check upload size
        if (uploadSize > MAX_IMAGE_UPLOAD_SIZE) {
          sendJson(ws, {
              type: "imageUploadError",
              uploadId: parsed.uploadId,
              filename,
              error: `File too large. Max allowed is ${Math.floor(
                MAX_IMAGE_UPLOAD_SIZE / 1024 / 1024
              )}MB. Your file is ${(uploadSize / 1024 / 1024).toFixed(2)}MB.`,
            });
          return;
        }

        if (ws.readyState !== WebSocket.OPEN || ws.imageUploadState) { return; }
        if (Array.from(roomClients).some((client) => client.imageUploadState?.uploadId === parsed.uploadId)) {
          sendJson(ws, { type: "imageUploadError", uploadId: parsed.uploadId,
            error: "This transfer ID is already active. Please retry." });
          return;
        }

        // Initialise one bounded upload after admission succeeds.
        startUpload(ws, roomClients, {
          uploadId: parsed.uploadId,
          filename,
          mimeType,
          size: uploadSize,
          chunks: [],
          received: 0,
          receivedBytes: 0,
          totalChunks: null,
        });
        sendJson(ws, { type: "imageUploadReady", uploadId: parsed.uploadId });

        // Broadcast start to all clients (including uploader)
        roomClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            sendJson(client, {
                type: "imageUploadStart",
                uploadId: parsed.uploadId,
                filename,
                mimeType,
                size: uploadSize,
              });
          }
        });
      } else if (parsed.type === "imageUploadChunk") {
        // Native processing must not block cancellation or subsequent control messages.
        handleImageUploadChunk(parsed, ws, roomClients, processImageBuffer,
          MAX_IMAGE_UPLOAD_SIZE, MAX_CHUNKS, MAX_CHUNK_BYTES).catch(() => ws.terminate());
      }
      return;
    }
  }

  // Serialise protocol admission; processing itself locks its state before yielding.
  let pendingMessages = 0;
  let pendingBytes = 0;
  let chain = Promise.resolve();
  ws.on("message", (message, isBinary) => {
    pendingBytes += message.length;
    if (++pendingMessages > 64 || pendingBytes > 2 * 1024 * 1024) { ws.terminate(); return; }
    chain = chain.then(() => {
      if (ws.readyState === WebSocket.OPEN) { return handleMessage(message, isBinary); }
    }).catch(() => {
      sendJson(ws, { type: "protocolError", error: "Message processing failed." });
      ws.terminate();
    }).finally(() => { pendingMessages--; pendingBytes -= message.length; });
  });

  ws.on("close", () => {
    sockets.delete(ws.id);
    if (ws.imageUploadState) { finishUpload(ws, roomClients, ws.imageUploadState, "Uploader disconnected."); }

    // Remove any invites owned by this socket and fail pending requests
    for (const [token, invite] of invites.pendingInvites.entries()) {
      if (invite.ownerSocketId === ws.id) {
        invites.deleteInvite(token, "owner_disconnected", sockets);
      }
    }
    const roomIsEmpty = leaveRoom(roomId, ws, clientIp);
    console.log(
      `Client disconnected: id=${ws.id}`
    );
    console.log(
      `Remaining clients: ${rooms.get(roomId)?.size || 0}`
    );

    // Notify other clients of disconnection
    const currentRoomClients = rooms.get(roomId) || [];
    currentRoomClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: "userDisconnected", ip: clientIp });
      }
    });
    if (roomIsEmpty) {
      console.log("Room is empty.");

      // cleanupRoomImages(roomId); // Removed as requested
    }
  });


});

// Heartbeats reclaim half-open connections and their room/upload resources.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

const PORT = positiveInteger("PORT", 3000);
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
