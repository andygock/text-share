require("dotenv").config();
const { RateLimiterMemory } = require("rate-limiter-flexible");

const GLOBAL_UPLOAD_LIMIT =
  parseInt(process.env.GLOBAL_UPLOAD_LIMIT, 10) || 100;
const PER_IP_UPLOAD_LIMIT = parseInt(process.env.PER_IP_UPLOAD_LIMIT, 10) || 10;

const GLOBAL_TEXT_LIMIT = parseInt(process.env.GLOBAL_TEXT_LIMIT, 10) || 500; // e.g. 500 text updates per hour
const PER_IP_TEXT_LIMIT = parseInt(process.env.PER_IP_TEXT_LIMIT, 10) || 100; // e.g. 100 text updates per hour

const globalUploadLimiter = new RateLimiterMemory({
  points: GLOBAL_UPLOAD_LIMIT, // global uploads per hour
  duration: 60 * 60, // per hour
  keyPrefix: "global_upload",
});
const ipUploadLimiter = new RateLimiterMemory({
  points: PER_IP_UPLOAD_LIMIT, // per IP uploads per hour
  duration: 60 * 60, // per hour
  keyPrefix: "ip_upload",
});

const globalTextLimiter = new RateLimiterMemory({
  points: GLOBAL_TEXT_LIMIT, // global text updates per hour
  duration: 60 * 60, // per hour
  keyPrefix: "global_text",
});
const ipTextLimiter = new RateLimiterMemory({
  points: PER_IP_TEXT_LIMIT, // per IP text updates per hour
  duration: 60 * 60, // per hour
  keyPrefix: "ip_text",
});

// Join / PIN request rate limits
const GLOBAL_JOIN_LIMIT = parseInt(process.env.GLOBAL_JOIN_LIMIT, 10) || 1000; // global join requests per hour
const PER_IP_JOIN_LIMIT = parseInt(process.env.PER_IP_JOIN_LIMIT, 10) || 30; // per IP join requests per hour

const globalJoinLimiter = new RateLimiterMemory({
  points: GLOBAL_JOIN_LIMIT,
  duration: 60 * 60,
  keyPrefix: "global_join",
});
const ipJoinLimiter = new RateLimiterMemory({
  points: PER_IP_JOIN_LIMIT,
  duration: 60 * 60,
  keyPrefix: "ip_join",
});

module.exports = {
  globalUploadLimiter,
  ipUploadLimiter,
  globalTextLimiter,
  ipTextLimiter,
  globalJoinLimiter,
  ipJoinLimiter,
};
