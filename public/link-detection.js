// Bound both scanning and rendering work, including text pasted before size validation.
window.extractDetectedLinks = function (text) {
  const links = [];
  const seen = new Set();
  const tokens = String(text || "").slice(0, 65536).matchAll(/[^\s<>"']+/g);
  for (const match of tokens) {
    if (links.length >= 100) { break; }
    if (match[0].length > 2048) { continue; }
    const display = match[0].replace(/^[([{]+/, "").replace(/[.,!;:'")\]]+$/, "");
    const href = /^https?:\/\//i.test(display) ? display : `https://${display}`;
    try {
      const url = new URL(href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) { continue; }
      const labels = url.hostname.split(".");
      if (labels.length < 2 || !/^[a-z]{2,}$/i.test(labels.at(-1)) ||
          !labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
        continue;
      }
      if (seen.has(url.href)) { continue; }
      seen.add(url.href);
      links.push({ display, href: url.href });
    } catch {
      // Plain text and malformed URL candidates are not clickable links.
    }
  }
  return links;
};
