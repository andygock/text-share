const MAX_ROOMS = 20;
const MAX_CLIENTS_PER_ROOM = 5;
const MAX_CLIENTS = 20;
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
  if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
    return { allowed: false, reason: "Maximum number of rooms reached." };
  }
  const roomClients = rooms.get(roomId) || new Set();
  if (roomClients.size >= MAX_CLIENTS_PER_ROOM) {
    return {
      allowed: false,
      reason: "Maximum number of clients in this room reached.",
    };
  }
  const totalClients = Array.from(rooms.values()).reduce(
    (acc, clients) => acc + clients.size,
    0
  );
  if (totalClients >= MAX_CLIENTS) {
    return { allowed: false, reason: "Maximum number of clients reached." };
  }
  if ((clientIpCount.get(clientIp) || 0) >= MAX_CLIENTS_PER_IP) {
    return {
      allowed: false,
      reason: "Maximum number of clients per IP reached.",
    };
  }
  return { allowed: true };
}

function joinRoom(roomId, ws, clientIp) {
  const roomClients = getOrCreateRoom(roomId);

  // ensure ws carries its ip so other code can read it; some older codepaths
  // may rely on ws.ip being set on the object
  try {
    if (!ws.ip) {
      ws.ip = clientIp;
    }
  } catch (e) {}
  if (!roomClients.has(ws)) {
    roomClients.add(ws);
    clientIpCount.set(clientIp, (clientIpCount.get(clientIp) || 0) + 1);
  }
}

function leaveRoom(roomId, ws, clientIp) {
  const roomClients = rooms.get(roomId);
  if (roomClients && roomClients.delete(ws)) {
    const count = (clientIpCount.get(clientIp) || 1) - 1;
    if (count === 0) {
      clientIpCount.delete(clientIp);
    } else {
      clientIpCount.set(clientIp, count);
    }
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
