// app.js
// Real-time Text & Image Share client
// Implements the Images Transfer Protocol (see Images-Transfer-Protocol.md)

// --- DOM Elements ---
const sharedTextarea = document.getElementById("sharedText");
const qrcodeDiv = document.getElementById("qrcode");
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
  width: 128,
  height: 128,
  colorDark: "#000",
  colorLight: "#fff",
  correctLevel: QRCode.CorrectLevel.H,
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
  closeBarcodesButton.style.display = "inline-block";
  barcodesDiv.style.display = "block";
});

closeBarcodesButton.addEventListener("click", () => {
  barcodesDiv.innerHTML = "";
  barcodesDiv.style.display = "none";
  closeBarcodesButton.style.display = "none";
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

function setImageUploadEnabled(enabled) {
  imageInput.disabled = !enabled;
  selectImageBtn.disabled = !enabled;
  dropArea.style.pointerEvents = enabled ? "auto" : "none";
  dropArea.style.opacity = enabled ? "1" : "0.5";

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
      infoMsg.style.color = "#a94442";
      infoMsg.style.fontSize = "0.95rem";
      infoMsg.style.margin = "0.5rem 0 0.5rem 0";
      infoMsg.style.textAlign = "center";
      infoMsg.textContent =
        "You cannot upload images because there is no one else connected to this room.";
      document
        .getElementById("image-share")
        .insertBefore(infoMsg, sharedImages);
    } else {
      infoMsg.style.display = "block";
    }
  } else {
    dropArea.title = "";
    selectImageBtn.title = "Select Image";
    if (infoMsg) infoMsg.style.display = "none";
  }
}

function updateUserList(users) {
  userListUl.innerHTML = "";
  users.forEach((ip) => addUserToList(ip));
  userCountSpan.textContent = users.length;
  userCountStickyNum.textContent = users.length;
  userCount = users.length;
  setImageUploadEnabled(userCount > 1);
}

function addUser(ip) {
  addUserToList(ip);
  userCount = parseInt(userCountSpan.textContent) + 1;
  userCountSpan.textContent = userCount;
  userCountStickyNum.textContent = userCount;
  setImageUploadEnabled(userCount > 1);
}

function removeUser(ip) {
  removeUserFromList(ip);
  userCount = parseInt(userCountSpan.textContent) - 1;
  userCountSpan.textContent = userCount;
  userCountStickyNum.textContent = userCount;
  setImageUploadEnabled(userCount > 1);
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
      img.style.maxWidth = "100%";
      img.style.maxHeight = "300px";
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
    if (uploadError.style.display === "block") {
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
  uploadError.style.display = "block";
  uploadError.textContent = msg;

  // clear upload status percentages too as they may be misleading, clear text and styles
  clearUploadStatusStyles();
  uploadStatus.textContent = "";

  setTimeout(() => {
    uploadError.style.display = "none";
    uploadError.textContent = "";
  }, 2000);
}

// --- Upload Status & Error Handling Utilities ---
function setUploadStatus({ text = "", show = false } = {}) {
  uploadStatus.textContent = text;
  uploadStatus.style.display = show && text ? "block" : "none";
}

function setUploadError({ text = "", show = false, timeout = 2000 } = {}) {
  uploadError.textContent = text;
  uploadError.style.display = show && text ? "block" : "none";
  if (show && text) {
    setUploadStatus({ text: "", show: false });
    setTimeout(() => {
      uploadError.style.display = "none";
      uploadError.textContent = "";
    }, timeout);
  }
}

function setGeneralError({ text = "", show = false, timeout = 3000 } = {}) {
  generalError.textContent = text;
  generalError.style.display = show && text ? "block" : "none";

  // If timeout is false, do not auto-hide the message; it will stay until this function is called again
  if (timeout === false) {
    return;
  }

  if (show && text && timeout > 0) {
    setTimeout(() => {
      generalError.style.display = "none";
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
  if (e.target.files && e.target.files[0]) {
    handleFileUpload(e.target.files[0]);
  }
});

dropArea.addEventListener("drop", (e) => {
  e.preventDefault();
  dropArea.classList.remove("dragover");
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
