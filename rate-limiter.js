require("dotenv").config();
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { positiveInteger } = require("./config");

const GLOBAL_UPLOAD_LIMIT =
  positiveInteger("GLOBAL_UPLOAD_LIMIT", 100);
const PER_IP_UPLOAD_LIMIT = positiveInteger("PER_IP_UPLOAD_LIMIT", 10);

const GLOBAL_TEXT_LIMIT = positiveInteger("GLOBAL_TEXT_LIMIT", 600);
const PER_IP_TEXT_LIMIT = positiveInteger("PER_IP_TEXT_LIMIT", 60);

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
  points: GLOBAL_TEXT_LIMIT, // global text updates per window
  duration: positiveInteger("TEXT_LIMIT_WINDOW_SECONDS", 10),
  keyPrefix: "global_text",
});
const ipTextLimiter = new RateLimiterMemory({
  points: PER_IP_TEXT_LIMIT, // per IP text updates per window
  duration: positiveInteger("TEXT_LIMIT_WINDOW_SECONDS", 10),
  keyPrefix: "ip_text",
});

// Join / PIN request rate limits
const GLOBAL_JOIN_LIMIT = positiveInteger("GLOBAL_JOIN_LIMIT", 1000); // global join requests per hour
const PER_IP_JOIN_LIMIT = positiveInteger("PER_IP_JOIN_LIMIT", 30); // per IP join requests per hour

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
