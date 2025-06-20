require("dotenv").config();

const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sharp = require("sharp");

const IMAGE_MAX_AGE_MS = 15 * 60 * 1000; // 60 minutes
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
const MULTER_FILE_SIZE_LIMIT =
  parseInt(process.env.MULTER_FILE_SIZE_LIMIT, 10) || 10 * 1024 * 1024; // default 10MB

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = require("uuid").v4() + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    const allowed = [".png", ".jpg", ".jpeg", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only images are allowed (png, jpg, webp)"));
    }
  },
  limits: { fileSize: MULTER_FILE_SIZE_LIMIT },
});

let imageMeta = [];

function cleanupOldImages() {
  const now = Date.now();
  imageMeta = imageMeta.filter((meta) => {
    if (now - meta.timestamp > IMAGE_MAX_AGE_MS) {
      try {
        fs.unlinkSync(meta.path);
      } catch {}
      return false;
    }
    return true;
  });
}

function cleanupRoomImages(roomId) {
  imageMeta = imageMeta.filter((meta) => {
    if (meta.roomId === roomId) {
      try {
        fs.unlinkSync(meta.path);
      } catch {}
      return false;
    }
    return true;
  });
}

async function processImage(inputPath, ext) {
  const tempOutputPath = inputPath + ".tmp";
  let image = sharp(inputPath);
  const metadata = await image.metadata();
  if (metadata.width > 1280 || metadata.height > 1280) {
    image = image.resize({ width: 1280, height: 1280, fit: "inside" });
  }
  image = image.rotate();
  if (ext === ".jpg" || ext === ".jpeg") {
    image = image.jpeg({ quality: 80, mozjpeg: true, force: true });
  } else if (ext === ".png") {
    image = image.png({ quality: 80, compressionLevel: 9, force: true });
  } else if (ext === ".webp") {
    image = image.webp({ quality: 80, force: true });
  }
  await image.toFile(tempOutputPath);
  let stats = fs.statSync(tempOutputPath);
  let quality = 70;
  while (stats.size > 500 * 1024 && quality >= 40) {
    if (ext === ".jpg" || ext === ".jpeg") {
      await sharp(tempOutputPath)
        .jpeg({ quality, mozjpeg: true, force: true })
        .toFile(tempOutputPath);
    } else if (ext === ".png") {
      await sharp(tempOutputPath)
        .png({ quality, compressionLevel: 9, force: true })
        .toFile(tempOutputPath);
    } else if (ext === ".webp") {
      await sharp(tempOutputPath)
        .webp({ quality, force: true })
        .toFile(tempOutputPath);
    }
    stats = fs.statSync(tempOutputPath);
    quality -= 10;
  }
  fs.renameSync(tempOutputPath, inputPath);
  return fs.statSync(inputPath);
}

module.exports = {
  upload,
  imageMeta,
  cleanupOldImages,
  cleanupRoomImages,
  processImage,
  UPLOAD_DIR,
};
