(() => {
  const form = document.getElementById("joinForm");
  const pinInput = document.getElementById("pinInput");
  const statusDiv = document.getElementById("joinStatus");

  if (!form || !pinInput || !statusDiv) {
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (form.dataset.pending === "true") { return; }
    const pin = (pinInput.value || "").trim();
    if (!/^[0-9]{6}$/.test(pin)) {
      statusDiv.textContent = "Please enter a 6-digit numeric PIN.";
      return;
    }
    statusDiv.textContent = "Requesting... waiting for owner to accept";
    form.dataset.pending = "true";
    const submit = form.querySelector('button[type="submit"]');
    if (submit) { submit.disabled = true; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 125000);
    try {
      const resp = await fetch("/request-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
        signal: controller.signal,
      });
      const body = await resp.json();
      if (!body.ok) {
        statusDiv.textContent = body.error || "Failed to request join";
        return;
      }

      // success: owner accepted; redirect to room
      statusDiv.textContent = "Accepted - joining...";
      window.location.href = body.roomUrl;
    } catch (err) {
      statusDiv.textContent = "Network error while requesting join.";
    } finally {
      clearTimeout(timeout);
      form.dataset.pending = "false";
      if (submit) { submit.disabled = false; }
    }
  });
})();
