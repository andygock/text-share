// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const MAX_ROOMS = 100; // Maximum number of rooms
const MAX_CLIENTS_PER_ROOM = 10; // Maximum number of clients per room
const MAX_CLIENTS = 100; // Maximum number of clients
const MAX_CLIENTS_PER_IP = 5; // Maximum number of clients per IP
const MAX_MESSAGE_SIZE = 1024; // Maximum message size in bytes

const app = express();

app.set("view engine", "ejs");
app.use(express.static("public")); // Serve static files from 'public' directory

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients in rooms, using UUID as room ID
const rooms = new Map();
const clientIpCount = new Map();

// Set up multer for image uploads
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = uuidv4() + ext;
    cb(null, name);
  },
});
const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    const allowed = [".png", ".jpg", ".jpeg", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only images are allowed (png, jpg, webp)"));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
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

  // Attempt to get the client's IP address from various sources
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",").shift() || // Check for forwarded IP (if behind a proxy)
    req.socket.remoteAddress || // Fallback to socket's remote address
    "127.0.0.1";

  if (rooms.size >= MAX_ROOMS) {
    ws.close(1008, "Maximum number of rooms reached.");
    return;
  }

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  const roomClients = rooms.get(roomId);

  if (roomClients.size >= MAX_CLIENTS_PER_ROOM) {
    ws.close(1008, "Maximum number of clients in this room reached.");
    return;
  }

  const totalClients = Array.from(rooms.values()).reduce(
    (acc, clients) => acc + clients.size,
    0
  );
  if (totalClients >= MAX_CLIENTS) {
    ws.close(1008, "Maximum number of clients reached.");
    return;
  }

  if (!clientIpCount.has(clientIp)) {
    clientIpCount.set(clientIp, 0);
  }
  if (clientIpCount.get(clientIp) >= MAX_CLIENTS_PER_IP) {
    ws.close(1008, "Maximum number of clients per IP reached.");
    return;
  }

  roomClients.add(ws);
  clientIpCount.set(clientIp, clientIpCount.get(clientIp) + 1);

  console.log(`Client connected to room ${roomId} from IP: ${clientIp}`);
  console.log(`Current clients in room ${roomId}: ${roomClients.size}`);

  // Send current user list to the newly connected client
  const userList = Array.from(roomClients).map((client) => client.ip); // Assuming we'll attach ip to ws later
  ws.send(JSON.stringify({ type: "userList", users: userList }));

  // Notify other clients of new connection
  roomClients.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "userConnected", ip: clientIp }));
    }
  });

  // Attach IP to the WebSocket object for later use
  ws.ip = clientIp;

  // Handle incoming messages from clients
  // Broadcast the message to all other clients in the room
  // Do not store messages on the server
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
    roomClients.delete(ws);
    clientIpCount.set(clientIp, clientIpCount.get(clientIp) - 1);
    console.log(`Client disconnected from room ${roomId} from IP: ${clientIp}`);

    console.log(`Remaining clients in room ${roomId}: ${roomClients.size}`);

    // Notify other clients of disconnection
    roomClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "userDisconnected", ip: clientIp }));
      }
    });

    if (roomClients.size === 0) {
      console.log(`Room ${roomId} is empty, cleaning up.`);
      rooms.delete(roomId);
      // In a more complex app, you might want to explicitly close sockets if needed,
      // but in this simple case, the server and client sockets should close naturally.
      // No explicit socket closing is needed here for basic cleanup.
    }
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error in room ${roomId}:`, error);
    roomClients.delete(ws); // Ensure client is removed on error as well
    clientIpCount.set(clientIp, clientIpCount.get(clientIp) - 1);
    if (roomClients.size === 0) {
      rooms.delete(roomId);
    }
  });
});

// Image upload endpoint
app.post("/:roomId/upload", upload.single("image"), (req, res) => {
  const roomId = req.params.roomId;
  if (!rooms.has(roomId)) {
    return res.status(400).json({ error: "Room does not exist." });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  // Broadcast image to all clients in the room
  const roomClients = rooms.get(roomId);
  roomClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "imageUpload",
          url: fileUrl,
          filename: req.file.originalname,
        })
      );
    }
  });
  res.json({ url: fileUrl });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
