const { positiveInteger } = require("./config");
const MAX_BUFFERED_BYTES = positiveInteger("MAX_BUFFERED_BYTES", 2 * 1024 * 1024);

// Slow or broken recipients must not retain an unbounded queue of shared data.
function sendJson(ws, message) {
  if (ws.readyState !== 1) {
    return false;
  }
  const data = JSON.stringify(message);
  if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) {
    ws.terminate();
    return false;
  }
  try {
    ws.send(data, (error) => {
      if (error) {
        ws.terminate();
      }
    });
    return true;
  } catch {
    ws.terminate();
    return false;
  }
}

module.exports = { sendJson };
