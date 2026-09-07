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
  "uploadId": "unique-transfer-id",
  "filename": "example.jpg",
  "mimeType": "image/jpeg",
  "size": 123456
}
```

### 2. `imageUploadChunk`

Sent by the uploader to the server after an `imageUploadReady` acknowledgement with the same `uploadId`. Original chunks are not relayed to recipients.

```json
{
  "type": "imageUploadChunk",
  "uploadId": "unique-transfer-id",
  "filename": "example.jpg",
  "chunkIndex": 0,
  "totalChunks": 10,
  "data": "...base64..."
}
```

- `data` is a canonical base64-encoded string representing one independently decodable chunk. Identical duplicate chunks are ignored; conflicting duplicates abort the upload. The assembled byte count must match the original declared size exactly.

### 3. `imageUploadProgress`

Sent by the server to all clients (including uploader) to indicate upload/download progress.

```json
{
  "type": "imageUploadProgress",
  "uploadId": "unique-transfer-id",
  "filename": "example.jpg",
  "progress": 42
}
```

### 4. `imageUploadComplete`

Sent by the server to all clients when the image transfer is complete, including image info.

```json
{
  "type": "imageUploadComplete",
  "uploadId": "unique-transfer-id",
  "filename": "example.jpg",
  "mimeType": "image/jpeg",
  "width": 800,
  "height": 600,
  "size": 456789,
  "data": "...complete processed image in base64..."
}
```

### 5. `imageUploadError`

Sent to the uploader for admission failures, or all current room members for an admitted transfer's failure, cancellation or timeout.

```json
{
  "type": "imageUploadError",
  "uploadId": "unique-transfer-id",
  "filename": "example.jpg",
  "error": "Image could not be compressed below 500 KiB."
}
```

## Flow

1. Uploader sends `imageUploadStart`.
2. Server admits the transfer, replies with `imageUploadReady`, and broadcasts `imageUploadStart`.
3. Uploader sends one or more `imageUploadChunk` messages, respecting outgoing backpressure.
4. Server broadcasts progress, validates exact size and processes the assembled image within its concurrency limit.
5. Server broadcasts a self-contained `imageUploadComplete` with processed bytes and the actual output MIME type. Clients track transfers by ID, allowing concurrent uploads and identical filenames.
6. An error, cancellation or deadline ends the transfer and frees its upload state. A sender can cancel using `{ "type": "imageUploadCancel", "uploadId": "unique-transfer-id" }`.
7. The uploader stays busy until a terminal response, disconnection or timeout. Late native processing results after cancellation are discarded.

## Notes

- All image data is transferred as base64-encoded strings for compatibility.
- The server assembles chunks in index order. Recipients decode the complete processed image from `imageUploadComplete.data`.
- Progress is calculated as the percentage of total chunks received, not processing progress.
- No image data is written to disk at any point.
