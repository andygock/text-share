(() => {
  // --- Helpers ---
  const $ = (sel) => document.getElementById(sel);
  const q = (sel) => document.querySelector(sel);
  const create = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    Object.assign(el, props);
    children.forEach((c) =>
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    );
    return el;
  };
  const safeSetText = (el, txt) => {
    if (el) el.textContent = txt;
  };

  // --- DOM ---
  const el = {
    sharedTextarea: $("sharedText"),
    qrcodeDiv: $("qrcode"),
    generatePinBtn: $("generate-pin"),
    pinValueSpan: $("pin-value"),
    pinExpiresSpan: $("pin-expires"),
    incomingRequestsDiv: $("incoming-requests"),
    userCountSpan: $("userCount"),
    userListUl: $("userList"),
    barcodesDiv: q(".barcodes"),
    generateBarcodesButton: $("generate-barcodes"),
    closeBarcodesButton: $("close-barcodes"),
    imageInput: $("imageInput"),
    selectImageBtn: $("selectImageBtn"),
    dropArea: $("dropArea"),
    sharedImages: $("sharedImages"),
    uploadStatus: $("uploadStatus"),
    uploadError: $("uploadError"),
    generalError: $("generalError"),
  };

  // Defensive extra
  const userCountStickyNum = $("userCountStickyNum");

  // --- Config & State ---
  const roomId = window.ROOM_ID;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${window.location.host}/${roomId}`);
  const MAX_IMAGE_UPLOAD_SIZE =
    window.MAX_IMAGE_UPLOAD_SIZE || 10 * 1024 * 1024;
  let inputHash = "";
  let currentPin = null;
  let currentPinInterval = null;
  let isUploading = false;
  let currentUploadFilename = null;
  let userCount = 0;

  // --- Utilities ---
  function crc32(str) {
    // small crc32 implementation (same as original)
    let crc = 0xffffffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i);
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    inputHash = (crc ^ 0xffffffff) >>> 0;
    return inputHash;
  }

  function splitBase64IntoChunks(base64, chunkSize) {
    const chunks = [];
    for (let i = 0; i < base64.length; i += chunkSize)
      chunks.push(base64.slice(i, i + chunkSize));
    return chunks;
  }

  // --- Status / Error UI ---
  function setUploadStatus({ text = "", show = false } = {}) {
    if (!el.uploadStatus) return;
    el.uploadStatus.textContent = text;
    el.uploadStatus.classList.toggle("visible", show && !!text);
  }
  function showUploadError(text, timeout = 2000) {
    if (!el.uploadError) return;
    el.uploadError.textContent = text;
    el.uploadError.classList.add("visible");
    setUploadStatus({ text: "", show: false });
    setTimeout(() => {
      el.uploadError.classList.remove("visible");
      el.uploadError.textContent = "";
    }, timeout);
  }
  function setGeneralError({ text = "", show = false, timeout = 3000 } = {}) {
    if (!el.generalError) return;
    el.generalError.textContent = text;
    el.generalError.classList.toggle("visible", show && !!text);
    if (timeout === false) return;
    if (show && text && timeout > 0)
      setTimeout(() => {
        el.generalError.classList.remove("visible");
        el.generalError.textContent = "";
      }, timeout);
  }

  // --- QR Code for Room ---
  if (el.qrcodeDiv) {
    try {
      new QRCode(el.qrcodeDiv, {
        text: window.location.href,
        width: 64,
        height: 64,
        colorDark: "#000",
        colorLight: "#fff",
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (e) {
      /* ignore if QR lib not loaded */
    }
  }

  // --- User list / UI toggles ---
  function updateH1UserCount(count) {
    const elH1 = $("h1-user-count");
    if (!elH1) return;
    if (!count || isNaN(count) || count <= 0) {
      elH1.textContent = "";
      elH1.classList.remove("green");
      return;
    }
    elH1.textContent = `(${
      count === 1 ? "1 user connected" : `${count} users connected`
    })`;
    elH1.classList.toggle("green", count > 1);
  }
  function setImageUploadEnabled(enabled) {
    if (el.imageInput) el.imageInput.disabled = !enabled;
    if (el.selectImageBtn) el.selectImageBtn.disabled = !enabled;
    if (el.dropArea) el.dropArea.classList.toggle("drop-disabled", !enabled);
    const infoId = "image-upload-info-msg";
    const parent = $("image-share");
    let infoMsg = infoId && document.getElementById(infoId);
    if (!enabled) {
      if (el.dropArea)
        el.dropArea.title =
          "You must have at least 2 users in the room to upload images.";
      if (el.selectImageBtn)
        el.selectImageBtn.title =
          "You must have at least 2 users in the room to upload images.";
      if (!infoMsg && parent) {
        infoMsg = create(
          "div",
          { id: infoId, className: "image-upload-info" },
          document.createTextNode(
            "You cannot upload images because there is no one else connected to this room."
          )
        );
        parent.insertBefore(infoMsg, el.sharedImages);
      } else if (infoMsg) infoMsg.classList.add("visible");
    } else {
      if (el.dropArea) el.dropArea.title = "";
      if (el.selectImageBtn) el.selectImageBtn.title = "Select Image";
      if (infoMsg) infoMsg.classList.remove("visible");
    }
  }

  function addUserToList(ip) {
    if (!el.userListUl) return;
    const li = create("li", {}, document.createTextNode(ip));
    li.dataset.ip = ip;
    el.userListUl.appendChild(li);
  }
  function removeUserFromList(ip) {
    if (!el.userListUl) return;
    const li = el.userListUl.querySelector(`li[data-ip="${ip}"]`);
    if (li) el.userListUl.removeChild(li);
  }
  function updateUserList(users = []) {
    if (!el.userListUl) return;
    el.userListUl.innerHTML = "";
    users.forEach(addUserToList);
    userCount = users.length;
    if (el.userCountSpan) el.userCountSpan.textContent = users.length;
    if (userCountStickyNum) userCountStickyNum.textContent = `${users.length}`;
    setImageUploadEnabled(userCount > 1);
    updateH1UserCount(userCount);
  }
  function addUser(ip) {
    addUserToList(ip);
    userCount = (parseInt(el.userCountSpan?.textContent || "0", 10) || 0) + 1;
    if (el.userCountSpan) el.userCountSpan.textContent = userCount;
    if (userCountStickyNum) userCountStickyNum.textContent = `${userCount}`;
    setImageUploadEnabled(userCount > 1);
    updateH1UserCount(userCount);
  }
  function removeUser(ip) {
    removeUserFromList(ip);
    userCount = Math.max(
      0,
      (parseInt(el.userCountSpan?.textContent || "0", 10) || 0) - 1
    );
    if (el.userCountSpan) el.userCountSpan.textContent = userCount;
    if (userCountStickyNum) userCountStickyNum.textContent = `${userCount}`;
    setImageUploadEnabled(userCount > 1);
    updateH1UserCount(userCount);
  }

  // --- Barcodes ---
  function generateTextAreaBarcodes() {
    if (!el.sharedTextarea || !el.barcodesDiv) return;
    const lines = el.sharedTextarea.value.split("\n");
    el.barcodesDiv.innerHTML = "";
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const item = create("div", { className: "barcode-item" });
      el.barcodesDiv.appendChild(item);
      try {
        new QRCode(item, {
          text: trimmed,
          width: 128,
          height: 128,
          colorDark: "#000",
          colorLight: "#fff",
          correctLevel: QRCode.CorrectLevel.H,
        });
      } catch (e) {
        /* ignore */
      }
      const txt = create(
        "div",
        { className: "barcode-text" },
        document.createTextNode(trimmed)
      );
      item.appendChild(txt);
    });
  }

  if (el.generateBarcodesButton) {
    el.generateBarcodesButton.addEventListener("click", () => {
      generateTextAreaBarcodes();
      el.generateBarcodesButton.dataset.hash = inputHash;
      el.generateBarcodesButton.disabled = true;
      el.closeBarcodesButton?.classList.add("visible");
      el.barcodesDiv?.classList.add("open");
    });
  }
  el.closeBarcodesButton?.addEventListener("click", () => {
    if (el.barcodesDiv) el.barcodesDiv.innerHTML = "";
    el.barcodesDiv?.classList.remove("open");
    el.closeBarcodesButton?.classList.remove("visible");
    if (el.generateBarcodesButton) el.generateBarcodesButton.disabled = false;
  });

  // --- Text sync ---
  el.sharedTextarea?.addEventListener("input", () => {
    try {
      ws.send(
        JSON.stringify({ type: "textUpdate", text: el.sharedTextarea.value })
      );
    } catch (e) {}
    crc32(el.sharedTextarea.value);
    if (el.generateBarcodesButton) el.generateBarcodesButton.disabled = false;
  });

  // --- Images Transfer Protocol (incoming state) ---
  let incomingFilename = "";
  let incomingMimeType = "";
  let incomingChunks = [];
  let incomingTotalChunks = 0;

  // --- Message handlers (map instead of big switch) ---
  const handlers = {
    textUpdate: (m) => {
      if (!el.sharedTextarea) return;
      el.sharedTextarea.value = m.text || "";
      crc32(el.sharedTextarea.value);
      if (el.generateBarcodesButton) el.generateBarcodesButton.disabled = false;
    },
    userList: (m) => updateUserList(m.users || []),
    userConnected: (m) => addUser(m.ip),
    userDisconnected: (m) => removeUser(m.ip),
    imageUploadStart: (m) => {
      incomingFilename = m.filename || "";
      incomingMimeType = m.mimeType || "";
      incomingChunks = [];
      incomingTotalChunks = 0;
      setUploadStatus({
        text: `Receiving image: ${incomingFilename}`,
        show: true,
      });
    },
    imageUploadChunk: (m) => {
      if (m.filename !== incomingFilename) return;
      incomingChunks[m.chunkIndex] = m.data;
      incomingTotalChunks = m.totalChunks || incomingTotalChunks;
    },
    imageUploadProgress: (m) => {
      if (
        m.filename === incomingFilename &&
        (!isUploading || m.filename !== currentUploadFilename)
      ) {
        setUploadStatus({ text: `Receiving... ${m.progress}%`, show: true });
      }
    },
    imageUploadComplete: (m) => {
      if (m.filename !== incomingFilename) return;
      const base64 = m.data || "";
      const img = create("img", {
        src: `data:${m.mimeType};base64,${base64}`,
        alt: m.filename,
        title: `${m.filename} (${m.width}x${m.height}, ${Math.ceil(
          m.size / 1024
        )}kB)`,
      });
      const info = create(
        "div",
        {},
        document.createTextNode(
          `${m.filename} (${m.width}x${m.height}, ${Math.ceil(
            m.size / 1024
          )}kB)`
        )
      );
      const wrap = create("div", { className: "shared-image-item" });
      wrap.appendChild(img);
      wrap.appendChild(info);
      el.sharedImages?.appendChild(wrap);
      setUploadStatus({ text: "Image received.", show: true });
      setTimeout(() => setUploadStatus({ text: "", show: false }), 2000);
      incomingFilename = "";
      incomingChunks = [];
      incomingTotalChunks = 0;
      incomingMimeType = "";
    },
    imageUploadError: (m) =>
      showUploadError(`Error uploading image: ${m.error || "unknown"}`),
    inviteGenerated: (m) => {
      if (currentPinInterval) {
        clearInterval(currentPinInterval);
        currentPinInterval = null;
      }
      currentPin = m.pin;
      safeSetText(el.pinValueSpan, m.pin || "");
      if (el.pinExpiresSpan) {
        let msLeft = Math.max(0, (m.expiresAt || 0) - Date.now());
        let seconds = Math.floor(msLeft / 1000);
        el.pinExpiresSpan.textContent = `Expires in ${seconds}s`;
        currentPinInterval = setInterval(() => {
          seconds -= 1;
          if (seconds <= 0) {
            el.pinExpiresSpan.textContent = "(expired)";
            if (el.pinValueSpan && el.pinValueSpan.textContent === currentPin)
              el.pinValueSpan.textContent = "";
            clearInterval(currentPinInterval);
            currentPinInterval = null;
            currentPin = null;
            return;
          }
          el.pinExpiresSpan.textContent = `Expires in ${seconds}s`;
        }, 1000);
      }
    },
    inviteExpired: (m) => {
      if (currentPin && m.pin === currentPin) {
        safeSetText(el.pinValueSpan, "");
        if (el.pinExpiresSpan) el.pinExpiresSpan.textContent = "(expired)";
        if (currentPinInterval) {
          clearInterval(currentPinInterval);
          currentPinInterval = null;
        }
        currentPin = null;
      }
    },
    inviteRemoved: (m) => {
      if (m && m.pin && currentPin === m.pin) {
        safeSetText(el.pinValueSpan, "");
        if (el.pinExpiresSpan)
          el.pinExpiresSpan.textContent = `(${m.reason || "removed"})`;
        if (currentPinInterval) {
          clearInterval(currentPinInterval);
          currentPinInterval = null;
        }
        currentPin = null;
      }
    },
    joinRequest: (m) => {
      if (!el.incomingRequestsDiv) return;
      const reqDiv = create("div", { className: "incoming-request-item" });
      reqDiv.dataset.requestId = m.requestId || "";
      // Build DOM safely to avoid XSS (do not use innerHTML with attacker-controlled values)
      const header = create("div");
      const strong = create(
        "strong",
        {},
        document.createTextNode("Join request")
      );
      header.appendChild(strong);
      header.appendChild(
        document.createTextNode(` — IP: ${m.requesterIP || "unknown"}`)
      );
      const uaDiv = create("div", { className: "incoming-request-ua" });
      uaDiv.textContent = m.ua || "";
      reqDiv.appendChild(header);
      reqDiv.appendChild(uaDiv);
      const btnAccept = create(
        "button",
        { className: "accept-btn" },
        document.createTextNode("Accept")
      );
      btnAccept.addEventListener("click", () => {
        try {
          ws.send(
            JSON.stringify({
              type: "respondInvite",
              requestId: m.requestId,
              accept: true,
            })
          );
        } catch (e) {}
        el.incomingRequestsDiv.removeChild(reqDiv);
      });
      const btnDeny = create("button", {}, document.createTextNode("Deny"));
      btnDeny.addEventListener("click", () => {
        try {
          ws.send(
            JSON.stringify({
              type: "respondInvite",
              requestId: m.requestId,
              accept: false,
            })
          );
        } catch (e) {}
        el.incomingRequestsDiv.removeChild(reqDiv);
      });
      const btnWrap = create("div", { className: "incoming-request-buttons" });
      btnWrap.appendChild(btnAccept);
      btnWrap.appendChild(btnDeny);
      reqDiv.appendChild(btnWrap);
      el.incomingRequestsDiv.appendChild(reqDiv);
    },
    textUpdateError: (m) =>
      showUploadError(m.error || "Text update rate limit exceeded."),
  };

  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    const h = handlers[m.type];
    if (h)
      try {
        h(m);
      } catch (e) {
        console.error("handler error", e);
      }
  };

  ws.onopen = () => console.log("WebSocket connection opened");
  ws.onclose = () => console.log("WebSocket connection closed");
  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    if (el.userListUl) el.userListUl.innerHTML = "";
    userCount = 0;
    if (el.userCountSpan) el.userCountSpan.textContent = "0";
    if (userCountStickyNum) userCountStickyNum.textContent = "0";
    setImageUploadEnabled(false);
    setUploadStatus({ text: "", show: false });
    setGeneralError({
      text: "Connection error. Please refresh the page.",
      show: true,
      timeout: false,
    });
  };

  // --- Upload logic ---
  async function uploadImage(file) {
    isUploading = true;
    currentUploadFilename = file.name;
    setUploadStatus({ text: "Processing image...", show: true });
    // Convert file to base64 safely using FileReader to avoid spreading large arrays
    const base64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          // fr.result is like: data:<mime-type>;base64,<data>
          const result = fr.result || "";
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        } catch (err) {
          reject(err);
        }
      };
      fr.onerror = (err) => reject(err);
      fr.readAsDataURL(file);
    });

    try {
      ws.send(
        JSON.stringify({
          type: "imageUploadStart",
          filename: file.name,
          mimeType: file.type,
          size: file.size,
        })
      );
    } catch (e) {}
    const chunkSize = 32 * 1024;
    const chunks = splitBase64IntoChunks(base64, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      try {
        ws.send(
          JSON.stringify({
            type: "imageUploadChunk",
            filename: file.name,
            chunkIndex: i,
            totalChunks: chunks.length,
            data: chunks[i],
          })
        );
      } catch (e) {}
      if (el.uploadError && el.uploadError.classList.contains("visible")) {
        // leave loop but continue sending? original continued, preserve same behavior by continuing
      }
      const percent = Math.round(((i + 1) / chunks.length) * 100);
      setUploadStatus({ text: `Uploading... ${percent}%`, show: true });
      // throttle to keep UI responsive & match original behavior
      await new Promise((r) => setTimeout(r, 10));
    }
    isUploading = false;
    currentUploadFilename = null;
  }

  function handleFileUpload(file) {
    if (isUploading)
      return showUploadError(
        "Only one file upload is allowed at a time. Please wait for the current upload to finish."
      );
    if (file.size > MAX_IMAGE_UPLOAD_SIZE)
      return showUploadError(
        `File too large. Max allowed is ${Math.floor(
          MAX_IMAGE_UPLOAD_SIZE / 1024 / 1024
        )}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB.`
      );
    uploadImage(file).catch((err) => {
      console.error("upload error", err);
      showUploadError("Upload failed.");
      isUploading = false;
      currentUploadFilename = null;
    });
  }

  // --- File input / drag & drop ---
  if (el.selectImageBtn)
    el.selectImageBtn.addEventListener("click", () => el.imageInput?.click());
  el.imageInput?.removeAttribute("multiple");
  el.imageInput?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    handleFileUpload(f);
  });

  if (el.dropArea) {
    el.dropArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.dropArea.classList.add("dragover");
    });
    el.dropArea.addEventListener("dragleave", () =>
      el.dropArea.classList.remove("dragover")
    );
    el.dropArea.addEventListener("drop", (e) => {
      e.preventDefault();
      el.dropArea.classList.remove("dragover");
      const f = e.dataTransfer?.files && e.dataTransfer.files[0];
      if (!f) return;
      handleFileUpload(f);
    });
  }

  // --- Incoming requests delegation removal (if owner wants to remove by button) ---
  // Note: we already attach click handlers to created Accept/Deny buttons.

  // --- Generate pin (owner) ---
  if (el.generatePinBtn)
    el.generatePinBtn.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        ws.send(JSON.stringify({ type: "generateInvite" }));
      } catch (err) {}
    });

  // --- Initial state ---
  setImageUploadEnabled(false);
})();
