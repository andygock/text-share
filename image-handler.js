require("dotenv").config();
const sharp = require("sharp");

// const UPLOAD_DIR = path.join(__dirname, "public", "uploads");

async function processImageBuffer(inputBuffer, ext) {
  let image = sharp(inputBuffer);
  const metadata = await image.metadata();
  if (metadata.width > 1280 || metadata.height > 1280) {
    image = image.resize({ width: 1280, height: 1280, fit: "inside" });
  }
  image = image.rotate();
  let outputBuffer;
  if (ext === ".jpg" || ext === ".jpeg") {
    outputBuffer = await image
      .jpeg({ quality: 80, mozjpeg: true, force: true })
      .toBuffer();
  } else if (ext === ".png") {
    outputBuffer = await image
      .png({ quality: 80, compressionLevel: 9, force: true })
      .toBuffer();
  } else if (ext === ".webp") {
    outputBuffer = await image.webp({ quality: 80, force: true }).toBuffer();
  } else {
    throw new Error("Unsupported image format");
  }
  let quality = 70;
  while (outputBuffer.length > 500 * 1024 && quality >= 40) {
    if (ext === ".jpg" || ext === ".jpeg") {
      outputBuffer = await sharp(outputBuffer)
        .jpeg({ quality, mozjpeg: true, force: true })
        .toBuffer();
    } else if (ext === ".png") {
      outputBuffer = await sharp(outputBuffer)
        .png({ quality, compressionLevel: 9, force: true })
        .toBuffer();
    } else if (ext === ".webp") {
      outputBuffer = await sharp(outputBuffer)
        .webp({ quality, force: true })
        .toBuffer();
    }
    quality -= 10;
  }
  const finalMeta = await sharp(outputBuffer).metadata();
  return {
    buffer: outputBuffer,
    width: finalMeta.width,
    height: finalMeta.height,
    size: outputBuffer.length,
  };
}

module.exports = {
  processImageBuffer,
};
