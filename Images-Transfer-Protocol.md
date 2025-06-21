# Images Transfer Protocol

This document describes the WebSocket-based protocol for real-time, in-memory image transfer between clients in the Real-time Text & Image Share application.

## Overview

- Images are never stored on disk. All processing and transfer is performed in memory.
- When a user uploads an image, it is processed (resized, compressed, metadata stripped) in memory on the server, then streamed to all other connected users in the room via WebSocket.
- Both uploaders and downloaders receive progress updates and image info (dimensions, file size).

## Message Types

### 1. `imageUploadStart`

Sent by the uploader to the server to initiate an image upload.

```json
{
  "type": "imageUploadStart",
  "filename": "example.jpg",
  "mimeType": "image/jpeg",
  "size": 123456 // original file size in bytes
}
```

### 2. `imageUploadChunk`

Sent by the uploader to the server, and relayed to all downloaders. Contains a chunk of the image file (ArrayBuffer, base64, or binary).

```json
{
  "type": "imageUploadChunk",
  "filename": "example.jpg",
  "chunkIndex": 0,
  "totalChunks": 10,
  "data": "...base64..."
}
```

- `data` is a base64-encoded string representing a chunk of the image file.

### 3. `imageUploadProgress`

Sent by the server to all clients (including uploader) to indicate upload/download progress.

```json
{
  "type": "imageUploadProgress",
  "filename": "example.jpg",
  "progress": 42 // percent (0-100)
}
```

### 4. `imageUploadComplete`

Sent by the server to all clients when the image transfer is complete, including image info.

```json
{
  "type": "imageUploadComplete",
  "filename": "example.jpg",
  "mimeType": "image/jpeg",
  "width": 800,
  "height": 600,
  "size": 456789 // processed file size in bytes
}
```

### 5. `imageUploadError`

Sent by the server to the uploader if an error occurs during upload or processing.

```json
{
  "type": "imageUploadError",
  "filename": "example.jpg",
  "error": "Image could not be compressed below 500kB."
}
```

## Flow

1. Uploader sends `imageUploadStart`.
2. Uploader sends one or more `imageUploadChunk` messages.
3. Server processes the image in memory, resampling and compressing as needed.
4. Server relays `imageUploadChunk` messages to all other clients in the room.
5. Server sends `imageUploadProgress` messages to all clients as chunks are received/relayed.
6. When upload is complete and image is processed, server sends `imageUploadComplete` with image info.
7. If an error occurs, server sends `imageUploadError` to the uploader.

## Notes

- All image data is transferred as base64-encoded strings for compatibility.
- Clients must reassemble chunks in order and decode base64 to reconstruct the image.
- Progress is calculated as the percentage of total chunks received/relayed.
- No image data is written to disk at any point.
