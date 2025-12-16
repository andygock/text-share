(() => {
  // --- Helpers ---

  const $ = (sel) => document.getElementById(sel);

  const q = (sel) => document.querySelector(sel);

  const create = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);

    // Assign a safe whitelist of properties to avoid accidental innerHTML/event injection
    if (props) {
      if (props.id) {
        el.id = props.id;
      }
      if (props.className) {
        el.className = props.className;
      }

      // element-specific attributes (safe whitelist)
      if (props.src) {
        el.src = props.src;
      }
      if (props.href) {
        // set href for anchors (use property so relative URLs are preserved)
        el.href = props.href;
      }
      if (props.target) {
        el.target = props.target;
      }
      if (props.rel) {
        el.rel = props.rel;
      }
      if (props.download) {
        // set download attribute for anchors
        el.download = props.download;
      }
      if (props.alt) {
        el.alt = props.alt;
      }
      if (props.title) {
        el.title = props.title;
      }
      if (props.type) {
        el.type = props.type;
      }
      if (props.value) {
        el.value = props.value;
      }
      if (props.dataset && typeof props.dataset === "object") {
        Object.keys(props.dataset).forEach(
          (k) => (el.dataset[k] = props.dataset[k])
        );
      }
    }
    children.forEach((c) =>
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    );
    return el;
  };

  const safeSetText = (el, txt) => {
    if (el) {
      el.textContent = txt;
    }
  };

  const LINK_DETECTION_REGEX =
    /\b((?:https?:\/\/)?(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/\S*)?)/gi;
  const NO_LINKS_MESSAGE = "No clickable links detected.";

  const normalizeLinkCandidate = (raw) => {
    if (!raw) {
      return null;
    }
    let trimmed = raw.trim();
    trimmed = trimmed.replace(/[.,!;:'")\]]+$/, "");
    if (!trimmed) {
      return null;
    }
    const hasScheme = /^https?:\/\//i.test(trimmed);
    const href = hasScheme ? trimmed : `https://${trimmed}`;
    return { display: trimmed, href };
  };

  const extractDetectedLinks = (text) => {
    if (!text) {
      return [];
    }
    const regex = new RegExp(LINK_DETECTION_REGEX.source, "gi");
    const seen = new Set();
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const candidate = match[1] || match[0];
      const normalized = normalizeLinkCandidate(candidate);
      if (!normalized) {
        continue;
      }
      if (seen.has(normalized.href)) {
        continue;
      }
      seen.add(normalized.href);
      matches.push(normalized);
    }
    return matches;
  };

  const renderDetectedLinks = (text) => {
    if (!el.detectedLinks) {
      return;
    }
    const container = el.detectedLinks;
    container.textContent = "";
    const links = extractDetectedLinks(text);
    if (!links.length) {
      container.dataset.empty = "true";
      container.textContent = NO_LINKS_MESSAGE;
      return;
    }
    container.dataset.empty = "false";
    links.forEach((link) => {
      const anchor = create(
        "a",
        {
          className: "detected-link",
          href: link.href,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        document.createTextNode(link.display)
      );
      container.appendChild(anchor);
    });
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
    detectedLinks: $("detected-links"),
    generalError: $("generalError"),
  };

  // --- Config & State ---
  const roomId = window.ROOM_ID;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  // WebSocket instance (will be created/recreated by createAndBindWebSocket)
  let ws = null;

  // Helper to safely send JSON over WebSocket with checks and user-visible errors
  function safeSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error("WebSocket not open; cannot send", obj);
      setGeneralError({
        text: "Not connected. Please wait for reconnection.",
        show: true,
        timeout: 3000,
      });
      return false;
    }
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      console.error("WebSocket send failed", err, obj);
      setGeneralError({ text: "Send failed.", show: true, timeout: 3000 });
      return false;
    }
  }

  // Reconnect controls
  let reconnectIntervalId = null;
  let reconnectStartTime = 0;
  const RECONNECT_INTERVAL = 5000; // try every 5s
  const RECONNECT_TIMEOUT = 30000; // stop trying after 30s

  function createAndBindWebSocket() {
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/${roomId}`
    );

    ws = socket;

    socket.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }

      const h = handlers[m.type];
      if (h) {
        try {
          h(m);
        } catch (e) {
          console.error("handler error", e);
        }
      }
    };

    socket.onopen = () => {
      console.log("WebSocket connection opened");

      // clear any reconnect attempts and errors
      if (reconnectIntervalId) {
        clearInterval(reconnectIntervalId);
        reconnectIntervalId = null;
        reconnectStartTime = 0;
      }

      setGeneralError({ text: "", show: false });
    };

    socket.onclose = () => {
      console.log("WebSocket connection closed");

      // Start reconnect attempts if not already started
      if (!reconnectIntervalId) {
        reconnectStartTime = Date.now();
        setGeneralError({
          text: "Connection lost. Attempting to reconnect...",
          show: true,
          timeout: false,
        });

        reconnectIntervalId = setInterval(() => {
          // stop trying after timeout
          if (Date.now() - reconnectStartTime >= RECONNECT_TIMEOUT) {
            clearInterval(reconnectIntervalId);
            reconnectIntervalId = null;
            setGeneralError({
              text: "Connection error. Please refresh the page.",
              show: true,
              timeout: false,
            });

            // ensure UI reflects disconnected state
            try {
              updateUserList([]);
            } catch (e) {
              if (el.userListUl) {
                el.userListUl.innerHTML = "";
              }
              userCount = 0;
              if (el.userCountSpan) {
                el.userCountSpan.textContent = "0";
              }
            }
            setImageUploadEnabled(false);
            setUploadStatus({ text: "", show: false });
            return;
          }
          try {
            console.log("Attempting WebSocket reconnect...");

            // Only create a new socket if there isn't one already OPEN or CONNECTING.
            // This prevents multiple simultaneous reconnect attempts which can
            // result in multiple active connections when the server comes back up.
            if (!ws || ws.readyState === WebSocket.CLOSED) {
              // create a fresh socket and bind handlers — onopen will clear the interval on success
              createAndBindWebSocket();
            } else {
              console.log(
                "Skipping reconnect: websocket already open/connecting",
                ws.readyState
              );
            }
          } catch (e) {
            // ignore and let interval continue
          }
        }, RECONNECT_INTERVAL);
      }
    };

    socket.onerror = (err) => {
      console.error("WebSocket error:", err);

      // clear user list and UI counters so the page reflects disconnected state
      try {
        updateUserList([]);
      } catch (e) {
        if (el.userListUl) {
          el.userListUl.innerHTML = "";
        }
        userCount = 0;
        if (el.userCountSpan) {
          el.userCountSpan.textContent = "0";
        }
      }

      setImageUploadEnabled(false);
      setUploadStatus({ text: "", show: false });

      // If we're currently reconnecting, show a reconnecting message; otherwise show final error.
      if (reconnectIntervalId) {
        setGeneralError({
          text: "Connection lost. Attempting to reconnect...",
          show: true,
          timeout: false,
        });
      } else {
        setGeneralError({
          text: "Connection error. Please refresh the page.",
          show: true,
          timeout: false,
        });
      }
    };

    return socket;
  }

  // Create initial connection
  createAndBindWebSocket();

  const MAX_IMAGE_UPLOAD_SIZE =
    window.MAX_IMAGE_UPLOAD_SIZE || 10 * 1024 * 1024;

  // Limit number of images kept in DOM to avoid unbounded memory growth
  const MAX_IMAGES_SHOWN = 20;

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
    for (let i = 0; i < base64.length; i += chunkSize) {
      chunks.push(base64.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // --- Status / Error UI ---

  function setUploadStatus({ text = "", show = false } = {}) {
    if (!el.uploadStatus) {
      return;
    }

    el.uploadStatus.textContent = text;
    el.uploadStatus.classList.toggle("visible", show && !!text);
  }

  function showUploadError(text, timeout = 2000) {
    if (!el.uploadError) {
      return;
    }

    el.uploadError.textContent = text;
    el.uploadError.classList.add("visible");
    setUploadStatus({ text: "", show: false });
    setTimeout(() => {
      el.uploadError.classList.remove("visible");
      el.uploadError.textContent = "";
    }, timeout);
  }

  function setGeneralError({ text = "", show = false, timeout = 3000 } = {}) {
    if (!el.generalError) {
      return;
    }

    el.generalError.textContent = text;
    el.generalError.classList.toggle("visible", show && !!text);
    if (timeout === false) {
      return;
    }
    if (show && text && timeout > 0) {
      setTimeout(() => {
        el.generalError.classList.remove("visible");
        el.generalError.textContent = "";
      }, timeout);
    }
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
    if (!elH1) {
      return;
    }
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
    if (el.imageInput) {
      el.imageInput.disabled = !enabled;
    }
    if (el.selectImageBtn) {
      el.selectImageBtn.disabled = !enabled;
    }
    if (el.dropArea) {
      el.dropArea.classList.toggle("drop-disabled", !enabled);
    }
    const infoId = "image-upload-info-msg";
    const parent = $("image-share");
    let infoMsg = infoId && document.getElementById(infoId);
    if (!enabled) {
      if (el.dropArea) {
        el.dropArea.title =
          "You must have at least 2 users in the room to upload images.";
      }
      if (el.selectImageBtn) {
        el.selectImageBtn.title =
          "You must have at least 2 users in the room to upload images.";
      }
      if (!infoMsg && parent) {
        infoMsg = create(
          "div",
          { id: infoId, className: "image-upload-info" },
          document.createTextNode(
            "You cannot upload images because there is no one else connected to this room."
          )
        );
        parent.insertBefore(infoMsg, el.sharedImages);
      } else if (infoMsg) {
        infoMsg.classList.add("visible");
      }
    } else {
      if (el.dropArea) {
        el.dropArea.title = "";
      }
      if (el.selectImageBtn) {
        el.selectImageBtn.title = "Select Image";
      }
      if (infoMsg) {
        infoMsg.classList.remove("visible");
      }
    }
  }

  function addUserToList(ip) {
    if (!el.userListUl) {
      return;
    }

    const li = create("li", {}, document.createTextNode(ip));
    li.dataset.ip = ip;
    el.userListUl.appendChild(li);
  }

  function removeUserFromList(ip) {
    if (!el.userListUl) {
      return;
    }

    // Avoid using querySelector with unescaped strings. Iterate and compare dataset values.
    const items = Array.from(el.userListUl.children || []);
    for (const li of items) {
      try {
        if (li && li.dataset && li.dataset.ip === ip) {
          if (li.remove) {
            li.remove();
          } else {
            el.userListUl.removeChild(li);
          }
          return;
        }
      } catch (err) {
        console.error("Error while removing user from list", err);
      }
    }
  }

  function updateUserList(users = []) {
    if (!el.userListUl) {
      return;
    }

    el.userListUl.innerHTML = "";
    users.forEach(addUserToList);
    userCount = users.length;
    if (el.userCountSpan) {
      el.userCountSpan.textContent = users.length;
    }
    setImageUploadEnabled(userCount > 1);
    updateH1UserCount(userCount);
  }

  function addUser(ip) {
    addUserToList(ip);
    userCount = (parseInt(el.userCountSpan?.textContent || "0", 10) || 0) + 1;
    if (el.userCountSpan) {
      el.userCountSpan.textContent = userCount;
    }
    setImageUploadEnabled(userCount > 1);
    updateH1UserCount(userCount);
  }

  function removeUser(ip) {
    removeUserFromList(ip);
    userCount = Math.max(
      0,
      (parseInt(el.userCountSpan?.textContent || "0", 10) || 0) - 1
    );
    if (el.userCountSpan) {
      el.userCountSpan.textContent = userCount;
    }
    setImageUploadEnabled(userCount > 1);
    updateH1UserCount(userCount);
  }

  // --- Barcodes ---

  function generateTextAreaBarcodes() {
    if (!el.sharedTextarea || !el.barcodesDiv) {
      return;
    }

    const lines = el.sharedTextarea.value.split("\n");
    el.barcodesDiv.innerHTML = "";
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
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

  if (el.closeBarcodesButton) {
    el.closeBarcodesButton.addEventListener("click", () => {
      if (el.barcodesDiv) {
        el.barcodesDiv.innerHTML = "";
      }
      el.barcodesDiv?.classList.remove("open");
      el.closeBarcodesButton?.classList.remove("visible");
      if (el.generateBarcodesButton) {
        el.generateBarcodesButton.disabled = false;
      }
    });
  }

  // --- Text sync ---

  if (el.sharedTextarea) {
    el.sharedTextarea.addEventListener("input", () => {
      renderDetectedLinks(el.sharedTextarea.value);
      safeSend({ type: "textUpdate", text: el.sharedTextarea.value });
      crc32(el.sharedTextarea.value);
      if (el.generateBarcodesButton) {
        el.generateBarcodesButton.disabled = false;
      }
    });
  }

  // --- Images Transfer Protocol (incoming state) ---
  let incomingFilename = "";
  let incomingMimeType = "";
  let incomingChunks = [];
  let incomingTotalChunks = 0;

  // --- Message handlers (map instead of big switch) ---
  const handlers = {
    textUpdate: (m) => {
      if (!el.sharedTextarea) {
        return;
      }
      el.sharedTextarea.value = m.text || "";
      crc32(el.sharedTextarea.value);
      renderDetectedLinks(el.sharedTextarea.value);
      if (el.generateBarcodesButton) {
        el.generateBarcodesButton.disabled = false;
      }
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
      if (m.filename !== incomingFilename) {
        return;
      }
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
      // Ensure this completion message matches the current incoming file
      if (m.filename !== incomingFilename) {
        return;
      }

      // If the server sent the full base64 in m.data use that; otherwise try to reassemble from incomingChunks
      let base64 = m.data || "";

      // Reassemble from chunks if needed
      if (!base64 && incomingChunks && incomingChunks.length) {
        base64 = incomingChunks.join("");
      }

      // Validate we have data
      if (!base64) {
        showUploadError("Incomplete image data received.");
        incomingFilename = "";
        incomingChunks = [];
        incomingTotalChunks = 0;
        incomingMimeType = "";
        return;
      }

      // Reconstruct data URL
      const src = `data:${m.mimeType};base64,${base64}`;

      // Create image element
      const img = create("img", {
        src,
        alt: m.filename,
        title: `${m.filename} (${m.width}x${m.height}, ${Math.ceil(
          m.size / 1024
        )}kB)`,
      });

      // Build info and download link
      const infoText = `${m.filename} (${m.width}x${m.height}, ${Math.ceil(
        m.size / 1024
      )}kB)`;
      const info = create(
        "a",
        {
          className: "info",
          href: src,
          download: m.filename,
          title: "Download this image",
        },
        document.createTextNode(infoText)
      );
      const wrap = create("div", { className: "shared-image-item" });

      // Wrap the image in an anchor so clicking the image downloads it too
      const imageLink = create(
        "a",
        { href: src, download: m.filename, title: `Download ${m.filename}` },
        img
      );
      wrap.appendChild(imageLink);
      wrap.appendChild(info);
      el.sharedImages?.appendChild(wrap);

      // Trim older images to avoid unbounded DOM growth
      try {
        while (
          el.sharedImages &&
          el.sharedImages.children &&
          el.sharedImages.children.length > MAX_IMAGES_SHOWN
        ) {
          const first = el.sharedImages.children[0];
          if (first && first.remove) {
            first.remove();
          } else if (first && first.parentNode) {
            first.parentNode.removeChild(first);
          }
        }
      } catch (err) {
        console.error("Error trimming shared images", err);
      }

      setUploadStatus({ text: "Image received.", show: true });
      setTimeout(() => setUploadStatus({ text: "", show: false }), 2000);

      // Reset incoming state
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
            if (el.pinValueSpan && el.pinValueSpan.textContent === currentPin) {
              el.pinValueSpan.textContent = "";
            }
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
        if (el.pinExpiresSpan) {
          el.pinExpiresSpan.textContent = "(expired)";
        }
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
        if (el.pinExpiresSpan) {
          el.pinExpiresSpan.textContent = `(${m.reason || "removed"})`;
        }
        if (currentPinInterval) {
          clearInterval(currentPinInterval);
          currentPinInterval = null;
        }
        currentPin = null;
      }
    },
    joinRequest: (m) => {
      if (!el.incomingRequestsDiv) {
        return;
      }
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
        safeSend({
          type: "respondInvite",
          requestId: m.requestId,
          accept: true,
        });
        if (reqDiv && typeof reqDiv.remove === "function") {
          reqDiv.remove();
        } else if (reqDiv && el.incomingRequestsDiv) {
          try {
            el.incomingRequestsDiv.removeChild(reqDiv);
          } catch (err) {
            console.error("failed to remove request div", err);
          }
        }
      });
      const btnDeny = create("button", {}, document.createTextNode("Deny"));
      btnDeny.addEventListener("click", () => {
        safeSend({
          type: "respondInvite",
          requestId: m.requestId,
          accept: false,
        });
        if (reqDiv && typeof reqDiv.remove === "function") {
          reqDiv.remove();
        } else if (reqDiv && el.incomingRequestsDiv) {
          try {
            el.incomingRequestsDiv.removeChild(reqDiv);
          } catch (err) {
            console.error("failed to remove request div", err);
          }
        }
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

  // --- Upload logic ---

  async function uploadImage(file) {
    isUploading = true;
    currentUploadFilename = file.name;
    setUploadStatus({ text: "Processing image...", show: true });

    // Convert file to base64 using file.arrayBuffer() (avoids FileReader)
    const base64 = await (async () => {
      // eslint-disable-next-line no-useless-catch
      try {
        // Read entire file into an ArrayBuffer
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Choose a chunk size that's a multiple of 3 so base64 chunking aligns.
        // 3072 bytes (3 * 1024) is small enough to avoid apply() limits in most browsers.
        const CHUNK_SIZE = 3 * 1024;
        let b64 = "";

        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
          const slice = bytes.subarray(i, i + CHUNK_SIZE);

          // Convert slice to a binary string, then to base64.
          // String.fromCharCode.apply(null, slice) works for small slices.
          b64 += btoa(String.fromCharCode.apply(null, slice));
        }

        return b64;
      } catch (err) {
        // propagate error to caller similar to original promise rejection, or do something else later
        throw err;
      }
    })();

    safeSend({
      type: "imageUploadStart",
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    });
    const chunkSize = 32 * 1024;
    const chunks = splitBase64IntoChunks(base64, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      safeSend({
        type: "imageUploadChunk",
        filename: file.name,
        chunkIndex: i,
        totalChunks: chunks.length,
        data: chunks[i],
      });
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
    if (isUploading) {
      return showUploadError(
        "Only one file upload is allowed at a time. Please wait for the current upload to finish."
      );
    }
    if (file.size > MAX_IMAGE_UPLOAD_SIZE) {
      return showUploadError(
        `File too large. Max allowed is ${Math.floor(
          MAX_IMAGE_UPLOAD_SIZE / 1024 / 1024
        )}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB.`
      );
    }
    uploadImage(file).catch((err) => {
      console.error("upload error", err);
      showUploadError("Upload failed.");
      isUploading = false;
      currentUploadFilename = null;
    });
  }

  // --- File input / drag & drop ---

  if (el.selectImageBtn) {
    el.selectImageBtn.addEventListener("click", () => {
      if (el.imageInput) {
        el.imageInput.click();
      }
    });
  }

  if (el.imageInput) {
    el.imageInput.removeAttribute("multiple");
    el.imageInput.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) {
        return;
      }

      handleFileUpload(f);
    });
  }

  if (el.dropArea) {
    el.dropArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.dropArea.classList.add("dragover");
    });

    el.dropArea.addEventListener("dragleave", () => {
      el.dropArea.classList.remove("dragover");
    });

    el.dropArea.addEventListener("drop", (e) => {
      e.preventDefault();
      el.dropArea.classList.remove("dragover");
      const f = e.dataTransfer?.files && e.dataTransfer.files[0];
      if (!f) {
        return;
      }
      handleFileUpload(f);
    });
  }

  // --- Incoming requests delegation removal (if owner wants to remove by button) ---
  // Note: we already attach click handlers to created Accept/Deny buttons.

  // --- Generate pin (owner) ---
  if (el.generatePinBtn) {
    el.generatePinBtn.addEventListener("click", (e) => {
      e.preventDefault();
      safeSend({ type: "generateInvite" });
    });
  }

  // --- Initial state ---
  setImageUploadEnabled(false);
  renderDetectedLinks(el.sharedTextarea?.value || "");
})();
