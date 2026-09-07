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
  const roomId = window.ROOM_ID || document.body?.dataset.roomId || "";
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

      if (!m || typeof m !== "object") { return; }
      const h = Object.hasOwn(handlers, m.type) ? handlers[m.type] : null;
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

    socket.onclose = (event) => {
      textReady = false;
      pendingText = null;
      updateUserList([]);
      incomingUploads.clear();
      resetUpload("Connection lost during upload.");
      el.incomingRequestsDiv?.replaceChildren();
      if (event.code === 1008 || event.code === 1009) {
        if (reconnectIntervalId) { clearInterval(reconnectIntervalId); reconnectIntervalId = null; }
        setGeneralError({ text: event.reason || "Connection rejected.", show: true, timeout: false });
        return;
      }
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
    Number(
      window.MAX_IMAGE_UPLOAD_SIZE || document.body?.dataset.maxImageUploadSize
    ) ||
    10 * 1024 * 1024;

  // Limit number of images kept in DOM to avoid unbounded memory growth
  const MAX_IMAGES_SHOWN = 20;

  let inputHash = "";
  let currentPin = null;
  let currentPinInterval = null;
  let isUploading = false;
  let currentUploadFilename = null;
  let activeUpload = null;
  let userCount = 0;
  let generalErrorTimer = null;
  let uploadErrorTimer = null;

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

    clearTimeout(uploadErrorTimer);
    el.uploadError.textContent = text;
    el.uploadError.classList.add("visible");
    setUploadStatus({ text: "", show: false });
    uploadErrorTimer = setTimeout(() => {
      el.uploadError.classList.remove("visible");
      el.uploadError.textContent = "";
    }, timeout);
  }

  function setGeneralError({ text = "", show = false, timeout = 3000 } = {}) {
    if (!el.generalError) {
      return;
    }

    clearTimeout(generalErrorTimer);
    el.generalError.textContent = text;
    el.generalError.classList.toggle("visible", show && !!text);
    if (timeout === false) {
      return;
    }
    if (show && text && timeout > 0) {
      generalErrorTimer = setTimeout(() => {
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
  // Revisions prevent a stale whole-document update from overwriting another writer.
  // Local drafts remain in the textarea until accepted or explicitly discarded.
  let revision = 0;
  let sharedText = "";
  let textReady = false;
  let textDirty = false;
  let pendingText = null;
  let textTimer = null;
  let maxTextBytes = 65536;
  let textConflict = false;
  let textHistoryEnabled = null;
  let relayBaseline = el.sharedTextarea?.value || "";
  const conflictPanel = create("div", { className: "text-conflict" });
  conflictPanel.hidden = true;
  const serverPreview = create("textarea");
  serverPreview.readOnly = true;
  serverPreview.setAttribute("aria-label", "Current shared text");
  const useShared = create("button", { type: "button" }, "Use shared version");
  const useDraft = create("button", { type: "button" }, "Share my version");
  conflictPanel.append(create("p", {}, "Text changed on another device. Your draft is preserved above."),
    serverPreview, useShared, useDraft);
  el.sharedTextarea?.after(conflictPanel);

  function renderSharedText(text) {
    el.sharedTextarea.value = text;
    renderDetectedLinks(text);
    crc32(text);
    if (el.generateBarcodesButton) { el.generateBarcodesButton.disabled = false; }
  }

  function showTextConflict() {
    textConflict = true;
    conflictPanel.hidden = false;
    serverPreview.value = sharedText;
  }

  function sendText() {
    clearTimeout(textTimer);
    if (!textReady || !textDirty || pendingText ||
      (textHistoryEnabled && textConflict)) { return; }
    const text = el.sharedTextarea.value;
    if (new TextEncoder().encode(text).length > maxTextBytes) {
      setGeneralError({ text: `Text exceeds ${maxTextBytes} UTF-8 bytes. Your draft has not been shared.`, show: true, timeout: false });
      return;
    }
    if (!textHistoryEnabled) {
      const delta = calculateTextDelta(relayBaseline, text);
      if (!delta) {
        textDirty = false;
        return;
      }
      if (safeSend({ type: "textDelta", ...delta })) {
        relayBaseline = text;
        textDirty = false;
      }
      return;
    }
    const updateId = makeId();
    pendingText = { updateId, text };
    if (!safeSend({ type: "textUpdate", text, baseRevision: revision, updateId })) {
      pendingText = null;
    }
  }

  function calculateTextDelta(previous, next) {
    if (previous === next) { return null; }
    let start = 0;
    while (start < previous.length && start < next.length &&
      previous[start] === next[start]) {
      start++;
    }
    let previousEnd = previous.length;
    let nextEnd = next.length;
    while (previousEnd > start && nextEnd > start &&
      previous[previousEnd - 1] === next[nextEnd - 1]) {
      previousEnd--;
      nextEnd--;
    }
    return {
      start,
      deleteCount: previousEnd - start,
      insert: next.slice(start, nextEnd),
    };
  }

  function receiveTextDelta(m) {
    if (textHistoryEnabled !== false || !Number.isSafeInteger(m.start) ||
      !Number.isSafeInteger(m.deleteCount) || typeof m.insert !== "string") {
      return;
    }

    // Flush an unsent local edit before applying the incoming operation. A
    // client joining mid-session has no base document, so out-of-range
    // positions are clamped and only newly relayed content becomes visible.
    if (textDirty) { sendText(); }
    const current = el.sharedTextarea.value;
    const start = Math.min(Math.max(0, m.start), current.length);
    const deleteCount = Math.min(Math.max(0, m.deleteCount), current.length - start);
    const next = current.slice(0, start) + m.insert + current.slice(start + deleteCount);
    if (new TextEncoder().encode(next).length > maxTextBytes) { return; }
    relayBaseline = next;
    textDirty = false;
    renderSharedText(next);
  }

  function receiveText(m) {
    revision = m.revision;
    sharedText = m.text;
    const ownUpdate = pendingText && pendingText.updateId === m.updateId;
    if (ownUpdate) {
      pendingText = null;
      textDirty = el.sharedTextarea.value !== sharedText;
      setGeneralError({ text: "", show: false });
      if (textDirty) { textTimer = setTimeout(sendText, 200); }
    } else if (textDirty) {
      if (el.sharedTextarea.value === sharedText) {
        textDirty = false;
      } else {
        showTextConflict();
      }
    } else {
      renderSharedText(sharedText);
    }
    if (textConflict) { serverPreview.value = sharedText; }
  }

  useShared.addEventListener("click", () => {
    if (!textReady) { return; }
    textDirty = false;
    textConflict = false;
    conflictPanel.hidden = true;
    renderSharedText(sharedText);
  });
  useDraft.addEventListener("click", () => {
    if (!textReady) { return; }
    textConflict = false;
    conflictPanel.hidden = true;
    textDirty = true;
    sendText();
  });
  if (el.sharedTextarea) {
    el.sharedTextarea.addEventListener("input", () => {
      textDirty = true;
      renderDetectedLinks(el.sharedTextarea.value);
      crc32(el.sharedTextarea.value);
      if (el.generateBarcodesButton) { el.generateBarcodesButton.disabled = false; }
      clearTimeout(textTimer);
      textTimer = setTimeout(sendText, 200);
    });
  }

  // Each transfer has an ID, including files with identical names from different users.
  const incomingUploads = new Map();

  // --- Message handlers (map instead of big switch) ---
  const handlers = {
    textUpdate: receiveText,
    textDelta: receiveTextDelta,
    textMode: (m) => {
      textHistoryEnabled = false;
      maxTextBytes = m.maxTextBytes;
      textReady = true;
      pendingText = null;
      textConflict = false;
      conflictPanel.hidden = true;
      relayBaseline = el.sharedTextarea?.value || "";
      textDirty = false;
    },
    textSnapshot: (m) => {
      textHistoryEnabled = true;
      maxTextBytes = m.maxTextBytes;
      textReady = true;
      receiveText(m);
      sendText();
    },
    textConflict: (m) => {
      pendingText = null;
      receiveText(m);
      if (textDirty) { showTextConflict(); }
    },
    userList: (m) => updateUserList(m.users || []),
    userConnected: (m) => addUser(m.ip),
    userDisconnected: (m) => removeUser(m.ip),
    imageUploadReady: (m) => {
      if (activeUpload?.id === m.uploadId) { activeUpload.ready(); }
    },
    imageUploadStart: (m) => {
      incomingUploads.set(m.uploadId, m);
      setUploadStatus({ text: `Receiving image: ${m.filename}`, show: true });
    },
    imageUploadProgress: (m) => {
      if (incomingUploads.has(m.uploadId)) {
        setUploadStatus({ text: `Receiving ${m.filename}... ${m.progress}%`, show: true });
      }
    },
    imageUploadComplete: (m) => {
      incomingUploads.delete(m.uploadId);
      if (activeUpload?.id === m.uploadId) { resetUpload(); }
      if (!m.data) { showUploadError("Incomplete image data received."); return; }

      // Completion is self-contained, including for recipients joining mid-transfer.
      const src = `data:${m.mimeType};base64,${m.data}`;

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

      // Transfer state was removed before rendering the completed image.
    },
    imageUploadError: (m) => {
      incomingUploads.delete(m.uploadId);
      if (activeUpload?.id === m.uploadId) { resetUpload(m.error || "Upload failed."); }
      showUploadError(`Error uploading image: ${m.error || "unknown"}`);
    },
    joinRequestRemoved: (m) => {
      for (const item of el.incomingRequestsDiv?.children || []) {
        if (item.dataset.requestId === m.requestId) { item.remove(); }
      }
    },
    inviteError: (m) => setGeneralError({ text: m.error, show: true }),
    respondInviteError: (m) => setGeneralError({ text: m.error, show: true }),
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
        if (!safeSend({
          type: "respondInvite",
          requestId: m.requestId,
          accept: true,
        })) { return; }
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
        if (!safeSend({
          type: "respondInvite",
          requestId: m.requestId,
          accept: false,
        })) { return; }
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
    textUpdateError: (m) => {
      pendingText = null;
      setGeneralError({ text: m.error, show: true, timeout: false });
      if (m.retryAfterMs) { clearTimeout(textTimer); textTimer = setTimeout(sendText, m.retryAfterMs); }
    },
  };

  // --- Upload logic ---

  function makeId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function resetUpload(error) {
    if (!activeUpload) { return; }
    const upload = activeUpload;
    activeUpload = null;
    clearTimeout(upload.timeout);
    if (error) { upload.reject(new Error(error)); }
    isUploading = false;
    currentUploadFilename = null;
    if (el.imageInput) { el.imageInput.value = ""; }
  }

  async function uploadImage(file) {
    isUploading = true;
    currentUploadFilename = file.name;
    const id = makeId();
    let ready;
    let reject;
    const readyPromise = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
    activeUpload = { id, ready, reject };
    activeUpload.timeout = setTimeout(() => {
      if (activeUpload?.id !== id) { return; }
      safeSend({ type: "imageUploadCancel", uploadId: id });
      resetUpload("Upload timed out.");
      showUploadError("Upload timed out.");
    }, 65000);
    try {
      if (!safeSend({ type: "imageUploadStart", uploadId: id, filename: file.name,
        mimeType: file.type, size: file.size })) {
        throw new Error("Not connected.");
      }
      await readyPromise;

      // Read only after server admission; chunks are independently base64 encoded.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const chunkSize = 24 * 1024;
      const totalChunks = Math.ceil(bytes.length / chunkSize);
      for (let i = 0; i < totalChunks; i++) {
        if (activeUpload?.id !== id) { return; }
        while (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount > 256 * 1024) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (activeUpload?.id !== id) { return; }
        }
        const slice = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
        const data = btoa(String.fromCharCode.apply(null, slice));
        if (!safeSend({ type: "imageUploadChunk", uploadId: id, filename: file.name,
          chunkIndex: i, totalChunks, data })) { throw new Error("Connection lost."); }
        setUploadStatus({ text: `Uploading... ${Math.round((i + 1) / totalChunks * 100)}%`, show: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (activeUpload?.id === id) {
        setUploadStatus({ text: "Processing image...", show: true });
      }

      // Remain busy until the server completes, rejects or times out this upload.
    } catch (error) {
      if (activeUpload?.id === id) {
        safeSend({ type: "imageUploadCancel", uploadId: id });
        resetUpload();
      }
      throw error;
    }
  }

  function handleFileUpload(file) {
    if (userCount < 2 || ws?.readyState !== WebSocket.OPEN) {
      return showUploadError("Connect another device before uploading.");
    }
    if (!file.size || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return showUploadError("Select a non-empty JPEG, PNG or WebP image.");
    }
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
