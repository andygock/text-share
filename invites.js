// invites.js
// Manages pending invites, pins and pending HTTP join requests

const pendingInvites = new Map(); // token -> invite
const pinToToken = new Map(); // pin -> token
const pendingRequests = new Map(); // requestId -> { res, timeout, inviteToken }

function generateUnique6DigitPin() {
  for (let i = 0; i < 10; i++) {
    const pin = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0");
    if (!pinToToken.has(pin)) {
      return pin;
    }
  }
  let pin;
  do {
    pin = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0");
  } while (pinToToken.has(pin));
  return pin;
}

function deleteInvite(token, reason = "removed", sockets) {
  const invite = pendingInvites.get(token);
  if (!invite) {
    return;
  }
  if (invite.timeoutId) {
    try {
      clearTimeout(invite.timeoutId);
    } catch (e) {}
  }
  pendingInvites.delete(token);
  pinToToken.delete(invite.pin);
  console.info(
    `invite: deleted token=${token} pin=${invite.pin} reason=${reason} owner=${invite.ownerSocketId}`
  );

  // notify owner if connected
  const ownerWs =
    sockets && sockets.get ? sockets.get(invite.ownerSocketId) : null;
  if (ownerWs && ownerWs.readyState === 1) {
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

function expireInvite(token, sockets) {
  console.info(`invite: expiring token=${token}`);
  deleteInvite(token, "expired", sockets);
}

module.exports = {
  pendingInvites,
  pinToToken,
  pendingRequests,
  generateUnique6DigitPin,
  deleteInvite,
  expireInvite,
};
