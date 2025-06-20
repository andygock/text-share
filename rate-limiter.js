require("dotenv").config();
const { RateLimiterMemory } = require("rate-limiter-flexible");

const GLOBAL_UPLOAD_LIMIT =
  parseInt(process.env.GLOBAL_UPLOAD_LIMIT, 10) || 100;
const PER_IP_UPLOAD_LIMIT = parseInt(process.env.PER_IP_UPLOAD_LIMIT, 10) || 10;

const globalLimiter = new RateLimiterMemory({
  points: GLOBAL_UPLOAD_LIMIT, // global uploads per hour
  duration: 60 * 60, // per hour
});
const ipLimiter = new RateLimiterMemory({
  points: PER_IP_UPLOAD_LIMIT, // per IP uploads per hour
  duration: 60 * 60, // per hour
  keyPrefix: "ip",
});

module.exports = {
  globalLimiter,
  ipLimiter,
};
