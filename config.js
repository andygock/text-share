// Reject invalid limits at startup rather than silently disabling protection.
function positiveInteger(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

module.exports = { positiveInteger };
