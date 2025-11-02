# Real-time Text & Image Share

A minimalist web application for sharing text and images between devices in real-time, privately and **without persistent storage**.

## Project Description

Real-time Text & Image Share is a simple and privacy-focused web application that allows you to instantly share text and images in PNG, JPG, or WEBP format between different devices such as desktop computers, mobile phones, and tablets. When you open the site, it generates a unique, random URL using UUID v4. Simply share this URL, for example by scanning the QR code, with other devices to create a private, real-time sharing room.

**Key Features:**

- **Real-time Synchronization:** Text and images shared on one device instantly appear on all other connected devices in the same room.
- **Image Sharing:** Upload or drag-and-drop images (PNG, JPG, WEBP) to share with all users in the room. Images are automatically resampled, compressed, and stripped of metadata for privacy and efficiency. Each image displays its dimensions and file size in the UI, and can be downloaded by any user.
- **In-Memory Image Handling (No Disk Storage):** Images are never written to disk. All image processing (resizing, compression, metadata removal) is performed in memory, and images are streamed directly to all connected users via WebSocket. This maximizes privacy and ensures no image files are ever stored on the server.
- **Automatic Image Optimization:** All images are processed on the server to be under 500kB, resized if needed, and have all metadata removed. If an image cannot be compressed below 500kB, the upload is rejected.
- **No Persistent Text/Data Storage:** No text or user data is stored persistently on the server. Text and user presence exist only in memory while users are connected.
- **Privacy Focused:** Designed with privacy in mind. No accounts, no tracking, no persistent server-side storage of your text or images.
- **Minimalist UI:** Clean and simple user interface for easy use on any device.
- **QR Code for Easy Sharing:** A QR code of the unique URL is automatically generated, making it easy to open the same room on mobile devices.
- **User Presence:** Displays the number of connected users and their IP addresses (for transparency within the room).
- **Room Cleanup:** Automatically closes WebSocket connections and frees up server resources when all users disconnect from a room.
- **Rate Limiting:** Uploads are rate-limited globally and per IP to prevent abuse.

## In-Memory Image Privacy Feature

- **No Temp Files:** Images are never written to disk. All uploads are processed and streamed in memory only.
- **Direct Streaming:** Uploaded images are streamed directly to all connected users (including the uploader) using WebSockets, after in-memory processing.
- **Progress & Info:** Both uploaders and downloaders see real-time progress and image info (dimensions, file size) during transfer.
- **Maximum Privacy:** No image data is ever stored on the server, even temporarily. This ensures maximum privacy for all users.
- **See [Images-Transfer-Protocol.md](./Images-Transfer-Protocol.md) for technical details.**

## Technology Stack

- **Backend:**
  - [Node.js](https://nodejs.org/) - JavaScript runtime environment
  - [Express.js](https://expressjs.com/) - Web application framework for Node.js
  - [ws](https://github.com/websockets/ws) - WebSocket library for Node.js
  - [uuid](https://github.com/uuidjs/uuid) - For generating UUID v4 room IDs
  - [sharp](https://github.com/lovell/sharp) - For image processing, compression, and metadata stripping
  - [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) - For upload rate limiting
- **Frontend:**
  - HTML5, CSS3, JavaScript (ES6+)
  - [qrcodejs](https://github.com/davidshimjs/qrcodejs) (via CDN) - For client-side QR code generation
- **Templating:**
  - [EJS](https://ejs.co/) - Embedded JavaScript templates

## Installation

1. **Clone the repository:**

    ```bash
    git clone https://github.com/andygock/text-share
    cd text-share
    ```

2. **Install Node.js dependencies:**

    I used **pnpm** for this project, but it should work with regular **npm** too.

    ```bash
    pnpm install
    ```

## Usage

1. For development, **Start the server:**

    ```bash
    pnpm dev
    ```

    The server will start on port 3000 (or the port specified by the `PORT` environment variable).

2. **Open in your browser:**

    Navigate to `http://localhost:3000` in your web browser. You will be automatically redirected to a unique URL like `http://localhost:3000/[uuid]`.

3. **Share the URL:**

    - **Scan the QR code:** Use a QR code scanner app on your mobile device to scan the QR code displayed on the page. This will open the same URL in your mobile browser.
    - **Manually type or copy the URL:**  Share the full URL (e.g., `http://localhost:3000/[uuid]`) with anyone you want to share text or images with.
    - Alternatively, you can use the "Share with PIN" feature described further below.

4. **Start sharing:**

    - **Text:** Begin typing in the textarea. The text will instantly synchronize with all other devices that are connected to the same URL.
    - **Images:** Upload or drag-and-drop an image file (PNG, JPG, WEBP) into the image sharing area. The image will be optimized and broadcast to all users in the room, showing its dimensions and file size. All users can download the image.

5. **User List:**

    The "Connected Users" section displays the number of users currently in the room and a list of their IP addresses.

6. **To end sharing:**

    Simply close the browser tab or window on all devices. Once all users disconnect, the room is automatically cleared on the server and all images are deleted.

### Join by PIN

If scanning a QR code or copying the full URL is not practical, you can use a 6-digit PIN to invite someone into your room. This is shown as a sub-option of "Share the URL":

- Click "Share with PIN" in the room UI. A temporary 6-digit code will be generated and shown on your screen (expires shortly).
- Read or type the 6-digit PIN to the other person. They should open the site and choose "Join with PIN" (or visit `/join`) and enter the code.
- The room owner will receive a join request and must Accept the request. Once accepted, the requester is redirected into the room.

Security notes

- The PIN is short (6 digits) by design for convenience; it is tied to a server-side ephemeral invite and expires quickly (default: 2 minutes).
- The owner must explicitly Accept the join request; repeated wrong attempts are limited and temporarily blocked.
- All communication uses the existing WebSocket channel and TLS/WSS when deployed over HTTPS.

---

**Disclaimer:** This is a simple, minimalist application intended for basic text and image sharing. It is provided as-is and may not be suitable for all use cases, especially those requiring high security or advanced features. Use at your own discretion.
