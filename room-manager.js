const { v4: uuidv4 } = require("uuid");

const MAX_ROOMS = 100;
const MAX_CLIENTS_PER_ROOM = 10;
const MAX_CLIENTS = 100;
const MAX_CLIENTS_PER_IP = 5;

const rooms = new Map();
const clientIpCount = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function canJoinRoom(roomId, clientIp) {
  if (rooms.size >= MAX_ROOMS)
    return { allowed: false, reason: "Maximum number of rooms reached." };
  const roomClients = getOrCreateRoom(roomId);
  if (roomClients.size >= MAX_CLIENTS_PER_ROOM)
    return {
      allowed: false,
      reason: "Maximum number of clients in this room reached.",
    };
  const totalClients = Array.from(rooms.values()).reduce(
    (acc, clients) => acc + clients.size,
    0
  );
  if (totalClients >= MAX_CLIENTS)
    return { allowed: false, reason: "Maximum number of clients reached." };
  if (!clientIpCount.has(clientIp)) clientIpCount.set(clientIp, 0);
  if (clientIpCount.get(clientIp) >= MAX_CLIENTS_PER_IP)
    return {
      allowed: false,
      reason: "Maximum number of clients per IP reached.",
    };
  return { allowed: true };
}

function joinRoom(roomId, ws, clientIp) {
  const roomClients = getOrCreateRoom(roomId);
  roomClients.add(ws);
  clientIpCount.set(clientIp, clientIpCount.get(clientIp) + 1);
}

function leaveRoom(roomId, ws, clientIp) {
  const roomClients = rooms.get(roomId);
  if (roomClients) {
    roomClients.delete(ws);
    clientIpCount.set(clientIp, clientIpCount.get(clientIp) - 1);
    if (roomClients.size === 0) {
      rooms.delete(roomId);
      return true; // room is now empty
    }
  }
  return false;
}

module.exports = {
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
};
