// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const {
  upload,
  imageMeta,
  cleanupOldImages,
  cleanupRoomImages,
  processImage,
  UPLOAD_DIR,
} = require("./image-handler");
const {
  MAX_ROOMS,
  MAX_CLIENTS_PER_ROOM,
  MAX_CLIENTS,
  MAX_CLIENTS_PER_IP,
  rooms,
  clientIpCount,
  getOrCreateRoom,
  canJoinRoom,
  joinRoom,
  leaveRoom,
} = require("./room-manager");
const { globalLimiter, ipLimiter } = require("./rate-limiter");

const MAX_MESSAGE_SIZE = 1024; // Maximum message size in bytes

const app = express();

app.set("view engine", "ejs");
app.use(express.static("public")); // Serve static files from 'public' directory

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Delete all images in the uploads directory on server start
fs.readdir(UPLOAD_DIR, (err, files) => {
  if (err) {
    console.error("Error reading upload directory:", err);
    return;
  }
  files.forEach((file) => {
    const filePath = path.join(UPLOAD_DIR, file);
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`Error deleting file ${file}:`, err);
      } else {
        console.log(`Deleted old image: ${file}`);
      }
    });
  });
});

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
  res.render("index", { roomId });
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

  ws.on("message", (message) => {
    if (message.length > MAX_MESSAGE_SIZE) {
      ws.close(1009, "Message size exceeds the maximum allowed.");
      return;
    }
    roomClients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({ type: "textUpdate", text: message.toString() })
        );
      }
    });
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
      console.log(`Room ${roomId} is empty, cleaning up.`);
      cleanupRoomImages(roomId);
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

// Image upload endpoint
app.post("/:roomId/upload", upload.single("image"), async (req, res) => {
  const roomId = req.params.roomId;
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",").shift() ||
    req.socket.remoteAddress ||
    "127.0.0.1";

  // Rate limiting with rate-limiter-flexible
  cleanupOldImages();
  try {
    await globalLimiter.consume("global");
    await ipLimiter.consume(clientIp);
  } catch (rejRes) {
    return res.status(429).json({ error: "Upload rate limit exceeded." });
  }

  if (!rooms.has(roomId)) {
    return res.status(400).json({ error: "Room does not exist." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  // Always process the image with sharp: strip metadata, resize if needed, compress
  const inputPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  let processed = false;
  let finalStats;
  try {
    finalStats = await processImage(inputPath, ext);
    processed = true;
  } catch (err) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    return res.status(400).json({ error: "Image processing failed." });
  }
  // Final check: if still too large, reject
  if (finalStats.size > 500 * 1024) {
    fs.unlinkSync(inputPath);
    return res
      .status(413)
      .json({ error: "Image could not be compressed below 500kB." });
  }

  // Track image meta for cleanup
  imageMeta.push({
    filename: req.file.filename,
    path: req.file.path,
    roomId,
    timestamp: Date.now(),
  });

  // Get image dimensions and size
  let width = 0,
    height = 0,
    sizeKB = 0;
  try {
    const sharpMeta = await require("sharp")(req.file.path).metadata();
    width = sharpMeta.width;
    height = sharpMeta.height;
    sizeKB = Math.ceil(finalStats.size / 1024);
  } catch {}

  const fileUrl = `/uploads/${req.file.filename}`;
  // Broadcast image to all clients in the room, including dimensions and size
  const roomClients = rooms.get(roomId);
  roomClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "imageUpload",
          url: fileUrl,
          filename: req.file.originalname,
          width,
          height,
          sizeKB,
        })
      );
    }
  });
  res.json({ url: fileUrl });
});

// Error handler for multer (file size, file type, etc.)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({ error: "File too large. Max size is 1MB." });
    }
    return res.status(400).json({ error: err.message });
  } else if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
