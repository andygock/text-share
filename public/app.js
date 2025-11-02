// app.js
// Real-time Text & Image Share client
// Implements the Images Transfer Protocol (see Images-Transfer-Protocol.md)

// --- DOM Elements ---
const sharedTextarea = document.getElementById("sharedText");
const qrcodeDiv = document.getElementById("qrcode");
const generatePinBtn = document.getElementById("generate-pin");
const pinValueSpan = document.getElementById("pin-value");
const pinExpiresSpan = document.getElementById("pin-expires");
const incomingRequestsDiv = document.getElementById("incoming-requests");
// Track the currently shown PIN and its expiry updater so we can clear when replaced
let currentPin = null;
let currentPinInterval = null;
const userCountSpan = document.getElementById("userCount");
const userCountStickyNum = document.getElementById("userCountStickyNum");
const userListUl = document.getElementById("userList");
const barcodesDiv = document.querySelector(".barcodes");
const generateBarcodesButton = document.getElementById("generate-barcodes");
const closeBarcodesButton = document.getElementById("close-barcodes");
const imageInput = document.getElementById("imageInput");
const selectImageBtn = document.getElementById("selectImageBtn");
const dropArea = document.getElementById("dropArea");
const sharedImages = document.getElementById("sharedImages");

const uploadStatus = document.getElementById("uploadStatus");
const uploadError = document.getElementById("uploadError");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const generalError = document.getElementById("generalError");

// --- Room and WebSocket Setup ---
const roomId = window.ROOM_ID;
const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const websocket = new WebSocket(
  `${protocol}://${window.location.host}/${roomId}`
);

// --- QR Code for Room URL ---
const currentUrl = window.location.href;
new QRCode(qrcodeDiv, {
  text: currentUrl,
  width: 64,
  height: 64,
  colorDark: "#000",
  colorLight: "#fff",
  correctLevel: QRCode.CorrectLevel.M,
});

// --- Text Sync & Barcode ---
let inputHash = "";
function crc32(str) {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function updateHash(str) {
  inputHash = crc32(str);
}

function generateTextAreaBarcodes() {
  const lines = sharedTextarea.value.split("\n");
  barcodesDiv.innerHTML = "";
  lines.forEach((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine) {
      const barcodeDiv = document.createElement("div");
      barcodeDiv.className = "barcode-item";
      barcodesDiv.appendChild(barcodeDiv);
      new QRCode(barcodeDiv, {
        text: trimmedLine,
        width: 128,
        height: 128,
        colorDark: "#000",
        colorLight: "#fff",
        correctLevel: QRCode.CorrectLevel.H,
      });
      const textDiv = document.createElement("div");
      textDiv.className = "barcode-text";
      textDiv.textContent = trimmedLine;
      barcodeDiv.appendChild(textDiv);
    }
  });
}

generateBarcodesButton.addEventListener("click", () => {
  generateTextAreaBarcodes();
  generateBarcodesButton.dataset.hash = inputHash;
  generateBarcodesButton.disabled = true;
  closeBarcodesButton.classList.add("visible");
  barcodesDiv.classList.add("open");
});

closeBarcodesButton.addEventListener("click", () => {
  barcodesDiv.innerHTML = "";
  barcodesDiv.classList.remove("open");
  closeBarcodesButton.classList.remove("visible");
  generateBarcodesButton.disabled = false;
});

sharedTextarea.addEventListener("input", () => {
  websocket.send(
    JSON.stringify({ type: "textUpdate", text: sharedTextarea.value })
  );
  updateHash(sharedTextarea.value);
  generateBarcodesButton.disabled = false;
});

// --- User List & Upload Enable ---
let userCount = 0;

// Update the H1 heading with user count for visibility
function updateH1UserCount(count) {
  try {
    const el = document.getElementById("h1-user-count");
    if (!el) return;
    if (typeof count !== "number" || isNaN(count) || count <= 0) {
      el.textContent = "";
      return;
    }
    const usersText =
      count === 1 ? "1 user connected" : `${count} users connected`;
    el.textContent = `(${usersText})`;
  } catch (e) {
    // ignore
  }
}

function setImageUploadEnabled(enabled) {
  imageInput.disabled = !enabled;
  selectImageBtn.disabled = !enabled;
  dropArea.classList.toggle("drop-disabled", !enabled);

  const infoMsgId = "image-upload-info-msg";
  let infoMsg = document.getElementById(infoMsgId);
  if (!enabled) {
    dropArea.title =
      "You must have at least 2 users in the room to upload images.";
    selectImageBtn.title =
      "You must have at least 2 users in the room to upload images.";
    if (!infoMsg) {
      infoMsg = document.createElement("div");
      infoMsg.id = infoMsgId;
      infoMsg.className = "image-upload-info";
      infoMsg.textContent =
        "You cannot upload images because there is no one else connected to this room.";
      document
        .getElementById("image-share")
        .insertBefore(infoMsg, sharedImages);
    } else {
      infoMsg.classList.add("visible");
    }
  } else {
    dropArea.title = "";
    selectImageBtn.title = "Select Image";
    if (infoMsg) infoMsg.classList.remove("visible");
  }
}

function updateUserList(users) {
  userListUl.innerHTML = "";
  users.forEach((ip) => addUserToList(ip));
  userCountSpan.textContent = users.length;
  userCountStickyNum.textContent = users.length;
  userCount = users.length;
  setImageUploadEnabled(userCount > 1);
  const userCountSticky = document.getElementById("userCountSticky");
  if (userCount >= 2) {
    userCountSticky.classList.add("active");
  } else {
    userCountSticky.classList.remove("active");
  }
  updateH1UserCount(userCount);
}

function addUser(ip) {
  addUserToList(ip);
  userCount = parseInt(userCountSpan.textContent) + 1;
  userCountSpan.textContent = userCount;
  userCountStickyNum.textContent = userCount;
  setImageUploadEnabled(userCount > 1);
  const userCountSticky = document.getElementById("userCountSticky");
  if (userCount >= 2) {
    userCountSticky.classList.add("active");
  } else {
    userCountSticky.classList.remove("active");
  }
  updateH1UserCount(userCount);
}

function removeUser(ip) {
  removeUserFromList(ip);
  userCount = parseInt(userCountSpan.textContent) - 1;
  userCountSpan.textContent = userCount;
  userCountStickyNum.textContent = userCount;
  setImageUploadEnabled(userCount > 1);
  const userCountSticky = document.getElementById("userCountSticky");
  if (userCount >= 2) {
    userCountSticky.classList.add("active");
  } else {
    userCountSticky.classList.remove("active");
  }
  updateH1UserCount(userCount);
}

function addUserToList(ip) {
  const li = document.createElement("li");
  li.textContent = ip;
  li.dataset.ip = ip;
  userListUl.appendChild(li);
}

function removeUserFromList(ip) {
  const userLi = userListUl.querySelector(`li[data-ip="${ip}"]`);
  if (userLi) {
    userListUl.removeChild(userLi);
  }
}

// --- Images Transfer Protocol (see Images-Transfer-Protocol.md) ---
// Handles: imageUploadStart, imageUploadChunk, imageUploadProgress, imageUploadComplete, imageUploadError
let incomingImage = null;
let incomingChunks = [];
let incomingTotalChunks = 0;
let incomingFilename = "";
let incomingMimeType = "";
let isUploading = false;
let currentUploadFilename = null;

websocket.onmessage = (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (message.type) {
    case "textUpdate":
      sharedTextarea.value = message.text;
      updateHash(message.text);
      generateBarcodesButton.disabled = false;
      break;
    case "userList":
      updateUserList(message.users);
      break;
    case "userConnected":
      addUser(message.ip);
      break;
    case "userDisconnected":
      removeUser(message.ip);
      break;
    case "imageUploadStart":
      // Protocol: Step 1 (see protocol doc)
      incomingImage = null;
      incomingChunks = [];
      incomingTotalChunks = 0;
      incomingFilename = message.filename;
      incomingMimeType = message.mimeType;
      setUploadStatus({
        text: `Receiving image: ${incomingFilename}`,
        show: true,
      });
      break;
    case "imageUploadChunk":
      // Protocol: Step 2/4 (see protocol doc)
      if (message.filename !== incomingFilename) return;
      incomingChunks[message.chunkIndex] = message.data;
      incomingTotalChunks = message.totalChunks;
      break;
    case "imageUploadProgress":
      // Protocol: Step 5 (see protocol doc)
      // Only show receive progress if not uploading this file
      if (
        message.filename === incomingFilename &&
        (!isUploading || message.filename !== currentUploadFilename)
      ) {
        setUploadStatus({
          text: `Receiving... ${message.progress}%`,
          show: true,
        });
      }
      break;
    case "imageUploadComplete":
      // Protocol: Step 6 (see protocol doc)
      if (message.filename !== incomingFilename) return;
      const base64 = message.data;
      const img = document.createElement("img");
      img.src = `data:${message.mimeType};base64,${base64}`;
      img.alt = message.filename;
      img.title = `${message.filename} (${message.width}x${
        message.height
      }, ${Math.ceil(message.size / 1024)}kB)`;
      // sizing handled by stylesheet
      const info = document.createElement("div");
      info.textContent = `${message.filename} (${message.width}x${
        message.height
      }, ${Math.ceil(message.size / 1024)}kB)`;
      const wrapper = document.createElement("div");
      wrapper.className = "shared-image-item";
      wrapper.appendChild(img);
      wrapper.appendChild(info);
      sharedImages.appendChild(wrapper);
      setUploadStatus({ text: "Image received.", show: true });
      setTimeout(() => setUploadStatus({ text: "", show: false }), 2000);
      incomingImage = null;
      incomingChunks = [];
      incomingTotalChunks = 0;
      incomingFilename = "";
      incomingMimeType = "";
      break;
    case "imageUploadError":
      // Protocol: Step 7 (see protocol doc)
      // console.log("Image upload error:", message.error);
      setUploadError({
        text: `Error uploading image: ${message.error}`,
        show: true,
      });
      break;
    case "inviteGenerated":
      // Clear any previous pin interval/display so we only show one active pin per client
      if (currentPinInterval) {
        clearInterval(currentPinInterval);
        currentPinInterval = null;
      }
      currentPin = message.pin;
      if (pinValueSpan) {
        pinValueSpan.textContent = message.pin;
      }
      if (pinExpiresSpan) {
        const msLeft = Math.max(0, message.expiresAt - Date.now());
        let seconds = Math.floor(msLeft / 1000);
        pinExpiresSpan.textContent = `Expires in ${seconds}s`;
        // update countdown every second
        currentPinInterval = setInterval(() => {
          seconds -= 1;
          if (seconds <= 0) {
            pinExpiresSpan.textContent = "(expired)";
            if (pinValueSpan && pinValueSpan.textContent === currentPin) {
              pinValueSpan.textContent = "";
            }
            clearInterval(currentPinInterval);
            currentPinInterval = null;
            currentPin = null;
            return;
          }
          pinExpiresSpan.textContent = `Expires in ${seconds}s`;
        }, 1000);
      }
      break;
    case "inviteExpired":
      // Only clear if this maps to the currently displayed PIN
      if (currentPin && message.pin === currentPin) {
        if (pinValueSpan) pinValueSpan.textContent = "";
        if (pinExpiresSpan) pinExpiresSpan.textContent = "(expired)";
        if (currentPinInterval) {
          clearInterval(currentPinInterval);
          currentPinInterval = null;
        }
        currentPin = null;
      }
      break;
    case "joinRequest":
      // show incoming request in owner's UI
      if (!incomingRequestsDiv) break;
      const reqDiv = document.createElement("div");
      reqDiv.className = "incoming-request-item";
      reqDiv.dataset.requestId = message.requestId;
      reqDiv.innerHTML = `<div><strong>Join request</strong> — IP: ${
        message.requesterIP || "unknown"
      }</div><div class='incoming-request-ua'>${message.ua || ""}</div>`;
      const btnAccept = document.createElement("button");
      btnAccept.textContent = "Accept";
      btnAccept.className = "accept-btn";
      btnAccept.addEventListener("click", () => {
        websocket.send(
          JSON.stringify({
            type: "respondInvite",
            requestId: message.requestId,
            accept: true,
          })
        );
        incomingRequestsDiv.removeChild(reqDiv);
      });
      const btnDeny = document.createElement("button");
      btnDeny.textContent = "Deny";
      btnDeny.addEventListener("click", () => {
        websocket.send(
          JSON.stringify({
            type: "respondInvite",
            requestId: message.requestId,
            accept: false,
          })
        );
        incomingRequestsDiv.removeChild(reqDiv);
      });
      const btnWrap = document.createElement("div");
      btnWrap.className = "incoming-request-buttons";
      btnWrap.appendChild(btnAccept);
      btnWrap.appendChild(btnDeny);
      reqDiv.appendChild(btnWrap);
      incomingRequestsDiv.appendChild(reqDiv);
      break;
    case "inviteRemoved":
      // Server indicates the invite was removed (replaced/owner_disconnected/expired)
      if (message && message.pin && currentPin === message.pin) {
        if (pinValueSpan) pinValueSpan.textContent = "";
        if (pinExpiresSpan)
          pinExpiresSpan.textContent = `(${message.reason || "removed"})`;
        if (currentPinInterval) {
          clearInterval(currentPinInterval);
          currentPinInterval = null;
        }
        currentPin = null;
      }
      break;
    case "textUpdateError":
      // we should really make a separate div for text update errors, instead of reusing uploadError
      // we'll just leave it for now though
      setUploadError({
        text: message.error || "Text update rate limit exceeded.",
        show: true,
      });
      break;
  }
};

// --- Image Upload (Protocol Steps 1-2) ---
function splitBase64IntoChunks(base64, chunkSize) {
  const chunks = [];
  for (let i = 0; i < base64.length; i += chunkSize) {
    chunks.push(base64.slice(i, i + chunkSize));
  }
  return chunks;
}

async function uploadImage(file) {
  isUploading = true;
  currentUploadFilename = file.name;
  setUploadStatus({ text: "Processing image...", show: true });
  const arrayBuffer = await file.arrayBuffer();
  websocket.send(
    JSON.stringify({
      type: "imageUploadStart",
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    })
  );
  const base64 = btoa(
    new Uint8Array(arrayBuffer).reduce(
      (data, byte) => data + String.fromCharCode(byte),
      ""
    )
  );
  const chunkSize = 32 * 1024;
  const chunks = splitBase64IntoChunks(base64, chunkSize);
  for (let i = 0; i < chunks.length; i++) {
    websocket.send(
      JSON.stringify({
        type: "imageUploadChunk",
        filename: file.name,
        chunkIndex: i,
        totalChunks: chunks.length,
        data: chunks[i],
      })
    );
    if (uploadError.classList.contains("visible")) {
      continue;
    }
    const percent = Math.round(((i + 1) / chunks.length) * 100);
    setUploadStatus({ text: `Uploading... ${percent}%`, show: true });
    await new Promise((r) => setTimeout(r, 10));
  }
  isUploading = false;
  currentUploadFilename = null;
}

// Max image upload size in bytes (from backend, fallback 10MB)
const MAX_IMAGE_UPLOAD_SIZE = window.MAX_IMAGE_UPLOAD_SIZE || 10 * 1024 * 1024;

function showUploadError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.add("visible");

  // clear upload status percentages too as they may be misleading, clear text and styles
  clearUploadStatusStyles();
  uploadStatus.textContent = "";

  setTimeout(() => {
    uploadError.classList.remove("visible");
    uploadError.textContent = "";
  }, 2000);
}

// --- Upload Status & Error Handling Utilities ---
function setUploadStatus({ text = "", show = false } = {}) {
  uploadStatus.textContent = text;
  uploadStatus.classList.toggle("visible", show && !!text);
}

function setUploadError({ text = "", show = false, timeout = 2000 } = {}) {
  uploadError.textContent = text;
  uploadError.classList.toggle("visible", show && !!text);
  if (show && text) {
    setUploadStatus({ text: "", show: false });
    setTimeout(() => {
      uploadError.classList.remove("visible");
      uploadError.textContent = "";
    }, timeout);
  }
}

function setGeneralError({ text = "", show = false, timeout = 3000 } = {}) {
  generalError.textContent = text;
  generalError.classList.toggle("visible", show && !!text);

  // If timeout is false, do not auto-hide the message; it will stay until this function is called again
  if (timeout === false) {
    return;
  }

  if (show && text && timeout > 0) {
    setTimeout(() => {
      generalError.classList.remove("visible");
      generalError.textContent = "";
    }, timeout);
  }
}

// Remove error styling from uploadStatus if present
function clearUploadStatusStyles() {
  uploadStatus.style.background = "";
  uploadStatus.style.color = "";
  uploadStatus.style.border = "";
  uploadStatus.style.fontWeight = "";
}

function handleFileUpload(file) {
  if (isUploading) {
    setUploadError({
      text: "Only one file upload is allowed at a time. Please wait for the current upload to finish.",
      show: true,
    });
    return;
  }
  if (file.size > MAX_IMAGE_UPLOAD_SIZE) {
    setUploadError({
      text: `File too large. Max allowed is ${Math.floor(
        MAX_IMAGE_UPLOAD_SIZE / 1024 / 1024
      )}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB.`,
      show: true,
    });
    return;
  }
  uploadImage(file);
}

selectImageBtn.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", (e) => {
  if (isUploading) {
    setUploadError({
      text: "Only one file upload is allowed at a time. Please wait for the current upload to finish.",
      show: true,
    });
    return;
  }
  if (e.target.files && e.target.files[0]) {
    handleFileUpload(e.target.files[0]);
  }
});

dropArea.addEventListener("drop", (e) => {
  e.preventDefault();
  dropArea.classList.remove("dragover");
  if (isUploading) {
    setUploadError({
      text: "Only one file upload is allowed at a time. Please wait for the current upload to finish.",
      show: true,
    });
    return;
  }
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

dropArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropArea.classList.add("dragover");
});

dropArea.addEventListener("dragleave", () =>
  dropArea.classList.remove("dragover")
);

// Ensure only one file can be selected in case the attribute is ever changed
imageInput.removeAttribute("multiple");

// --- WebSocket Connection Events ---
websocket.onopen = () => {
  console.log("WebSocket connection opened");
};

websocket.onclose = () => {
  console.log("WebSocket connection closed");
};

websocket.onerror = (error) => {
  console.error("WebSocket error:", error);
  userListUl.innerHTML = "";
  userCount = 0;
  userCountSpan.textContent = "0";
  userCountStickyNum.textContent = "0";
  setImageUploadEnabled(false);
  setUploadStatus({ text: "", show: false });
  setGeneralError({
    text: "Connection error. Please refresh the page.",
    show: true,
    timeout: false,
  });
};

// --- Initial State ---
setImageUploadEnabled(false);

// Generate PIN button (owner)
if (generatePinBtn) {
  generatePinBtn.addEventListener("click", (e) => {
    e.preventDefault();
    websocket.send(JSON.stringify({ type: "generateInvite" }));
  });
}
