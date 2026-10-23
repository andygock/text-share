const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ window: {}, URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/link-detection.js"), "utf8"), context);
const extract = context.window.extractDetectedLinks;

test("link detection validates URLs and deduplicates normalised destinations", () => {
  const links = extract("(example.com) https://example.com/ https://example.org:8443/path?q=1 javascript:alert(1) user@example.net");
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "https://example.com/");
  assert.equal(links[1].href, "https://example.org:8443/path?q=1");
});

test("link detection bounds adversarial input and output", () => {
  vm.runInContext('window.extractDetectedLinks("a.".repeat(32768))', context, { timeout: 1000 });
  assert.equal(extract("a.".repeat(32768)).length, 0);
  assert.equal(extract("x".repeat(65536) + " example.com").length, 0);
  const links = extract(Array.from({ length: 200 }, (_, i) => `https://site${i}.example`).join(" "));
  assert.equal(links.length, 100);
});
