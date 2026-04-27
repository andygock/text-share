(() => {
  const form = document.getElementById("joinForm");
  const pinInput = document.getElementById("pinInput");
  const statusDiv = document.getElementById("joinStatus");

  if (!form || !pinInput || !statusDiv) {
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = (pinInput.value || "").trim();
    if (!/^[0-9]{6}$/.test(pin)) {
      statusDiv.textContent = "Please enter a 6-digit numeric PIN.";
      return;
    }
    statusDiv.textContent = "Requesting... waiting for owner to accept";
    try {
      const resp = await fetch("/request-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
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
    }
  });
})();
