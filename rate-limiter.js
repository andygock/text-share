const { RateLimiterMemory } = require("rate-limiter-flexible");

const globalLimiter = new RateLimiterMemory({
  points: 100, // global: 100 uploads per hour
  duration: 60 * 60, // per hour
});
const ipLimiter = new RateLimiterMemory({
  points: 10, // per IP: 10 uploads per hour
  duration: 60 * 60, // per hour
  keyPrefix: "ip",
});

module.exports = {
  globalLimiter,
  ipLimiter,
};
