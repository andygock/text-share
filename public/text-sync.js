// Text synchronisation owns draft, acknowledgement and conflict state independently of transport.
window.createTextSync = function ({ el, create, renderDetectedLinks, crc32, safeSend, makeId, setGeneralError }) {
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
      const updateId = makeId();
      pendingText = { updateId, text };
      if (!safeSend({ type: "textDelta", ...delta, updateId })) {
        pendingText = null;
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

    // Relay mode has no authoritative document. Apply remote edits to both the
    // accepted baseline and local draft without treating unsent text as delivered.
    const apply = (text) => {
      const start = Math.min(Math.max(0, m.start), text.length);
      const count = Math.min(Math.max(0, m.deleteCount), text.length - start);
      return text.slice(0, start) + m.insert + text.slice(start + count);
    };
    const next = apply(el.sharedTextarea.value);
    if (new TextEncoder().encode(next).length > maxTextBytes) { return; }
    relayBaseline = apply(relayBaseline);
    if (pendingText) { pendingText.text = apply(pendingText.text); }
    textDirty = next !== relayBaseline;
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

  return {
    disconnect() {
      textReady = false;
      pendingText = null;
      clearTimeout(textTimer);
    },
    handlers: {
      textUpdate: receiveText,
      textDelta: receiveTextDelta,
      textDeltaAccepted: (m) => {
        if (textHistoryEnabled !== false || pendingText?.updateId !== m.updateId) { return; }
        relayBaseline = pendingText.text;
        pendingText = null;
        textDirty = el.sharedTextarea.value !== relayBaseline;
        setGeneralError({ text: "", show: false });
        if (textDirty) { textTimer = setTimeout(sendText, 200); }
      },
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
      textUpdateError: (m) => {
        if (m.updateId && pendingText?.updateId !== m.updateId) { return; }
        pendingText = null;
        setGeneralError({ text: m.error, show: true, timeout: false });
        if (m.retryAfterMs) { clearTimeout(textTimer); textTimer = setTimeout(sendText, m.retryAfterMs); }
      },
    },
  };
};
