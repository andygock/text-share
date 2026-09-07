// Reject invalid limits at startup rather than silently disabling protection.
function positiveInteger(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

function booleanFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be either true or false`);
}

module.exports = { booleanFlag, positiveInteger };
