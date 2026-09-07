# Real-time Text & Image Share

A minimalist web application for sharing text and images between devices in real-time, privately and **without persistent storage**.

## Project Description

Real-time Text & Image Share is a simple and privacy-focused web application that allows you to instantly share text and images in PNG, JPG, or WEBP format between different devices such as desktop computers, mobile phones, and tablets. When you open the site, it generates a unique, random URL using UUID v4. Simply share this URL, for example by scanning the QR code, with other devices to create a private, real-time sharing room.

**Key Features:**

- **Real-time Synchronisation:** Text updates are debounced and shared between connected devices. Optional in-memory history gives new and reconnecting devices the current room text, with revision checks that preserve conflicting local drafts.
- **Image Sharing:** Upload or drag-and-drop images (PNG, JPG, WEBP) to share with all users in the room. Images are automatically resampled, compressed, and stripped of metadata for privacy and efficiency. Each image displays its dimensions and file size in the UI, and can be downloaded by any user.
- **In-Memory Image Handling (No Disk Storage):** Images are never written to disk. All image processing (resizing, compression, metadata removal) is performed in memory, and images are streamed directly to all connected users via WebSocket. This maximizes privacy and ensures no image files are ever stored on the server.
- **Automatic Image Optimization:** All images are processed on the server to be under 500kB, resized if needed, and have all metadata removed. If an image cannot be compressed below 500kB, the upload is rejected.
- **Optional Text History:** Relay-only mode sends live edit deltas without retaining room text. When in-memory history is enabled, the server retains only the latest text and revision while the room has connected users; it does not keep a version log or write text to disk.
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
- **Transient Memory Only:** Image bytes exist in server memory during upload and processing, then are released. When text history is enabled, the current text remains in memory until the last room member disconnects. Connected browsers retain received content independently of server storage.
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
  - [qrcodejs](https://github.com/davidshimjs/qrcodejs) (served locally) - For client-side QR code generation
- **Templating:**
  - [EJS](https://ejs.co/) - Embedded JavaScript templates

## Installation

1. **Clone the repository:**

    ```bash
    git clone https://github.com/andygock/text-share
    cd text-share
    ```

2. **Install Node.js dependencies:**

    Use **pnpm** and a current Node.js version supporting CommonJS loading of ESM dependencies (Node.js 22.12 or later).

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

## Reverse Proxy Setup

If you run this behind nginx on a VPS, the app will only show real client IPs when it can trust the proxy that is forwarding the request.

Set `TRUSTED_PROXY_IPS` to the IP address of the proxy hop that connects to Node.js. For a common local nginx setup, that is usually:

```env
TRUSTED_PROXY_IPS=127.0.0.1,::1
```

If nginx runs on a different machine, use that machine's IP instead of loopback addresses.

Example nginx headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

If `TRUSTED_PROXY_IPS` is not set, the server intentionally falls back to the socket address. Behind nginx on the same VPS, that usually means `127.0.0.1` or `::1`.

The application resolves forwarded addresses from right to left, stopping at the first untrusted hop. Configure only proxies you control, and have the outermost trusted proxy overwrite `X-Forwarded-Proto`. For HTTPS deployments, set `ALLOWED_ORIGINS` to the public origin, including a non-default port where applicable. When it is unset, the same-origin check recognises `X-Forwarded-Proto: https` only from a trusted immediate proxy.

For HTTP access over a private LAN, leave `ENABLE_UPGRADE_INSECURE_REQUESTS=false` (the default). Enabling CSP's `upgrade-insecure-requests` on an HTTP LAN page upgrades relative JavaScript and WebSocket resources to HTTPS, which requires TLS on the LAN listener.

### Join by PIN

If scanning a QR code or copying the full URL is not practical, you can use a 6-digit PIN to invite someone into your room. This is shown as a sub-option of "Share the URL":

- Click "Share with PIN" in the room UI. A temporary 6-digit code will be generated and shown on your screen (expires shortly).
- Read or type the 6-digit PIN to the other person. They should open the site and choose "Join with PIN" (or visit `/join`) and enter the code.
- The room owner will receive a join request and must Accept the request. Once accepted, the requester is redirected into the room.

Security notes

- The PIN is short (6 digits) by design for convenience; it is tied to a server-side ephemeral invite and expires quickly (default: 30 seconds).
- The owner must explicitly accept the join request. Accepting consumes the invite and rejects other requests waiting on that code. HTTP join requests are rate-limited, and each invite permits at most five requests by default.
- All communication uses the existing WebSocket channel and TLS/WSS when deployed over HTTPS.

### Limits and Recovery

All numeric environment settings must be positive integers. See `.env.example` for defaults. Text limits now apply per `TEXT_LIMIT_WINDOW_SECONDS` (10 seconds by default), rather than per hour; update existing deployments accordingly. The default allowances are 60 updates per IP and 600 globally per window. Upload and join allowances remain hourly.

`TEXT_HISTORY_ENABLED=false` is the privacy-first default. The server validates and broadcasts compact text operations containing a start position, deletion count and inserted text, but does not attach a text state to the room. New or reconnecting clients receive no previous content and begin with only deltas received after connecting. Because there is no authoritative baseline or revision in this mode, simultaneous edits are best-effort and clients that join midway may display only the newly changed fragments.

Set `TEXT_HISTORY_ENABLED=true` when reconnect recovery and consistent conflict handling matter more than transient server retention. In this mode the server stores one current text value and revision per active room; each accepted edit replaces that value, so there is no revision history. It sends the current value when a client joins or reconnects.

The application-level retained value is destroyed synchronously when the room's final WebSocket disconnects: the text field is cleared, the state reference is removed and the room is deleted from the in-memory map. JavaScript strings cannot be securely zeroed, so V8 reclaims the now-unreachable underlying memory during a later garbage-collection cycle. An unresponsive connection is terminated by the 30-second heartbeat after it misses a heartbeat response, which then triggers the same cleanup. A process restart or shutdown also discards every room. There is no idle expiry while at least one responsive client remains connected.

Uploads require server acknowledgement before chunks are sent. Each transfer has a unique ID, a 60-second deadline, exact byte accounting, and one active upload per connection. At most two images are processed concurrently, with a 40-million-pixel input limit. Busy processing rejects the upload so the sender can retry. Slow recipients exceeding the outgoing buffer limit are disconnected; heartbeat checks reclaim unresponsive connections.

Room URLs grant access to anyone possessing them. PIN approval provides a convenient way to obtain that URL, not a separate authentication layer. Application logs omit room URLs, PINs and invite tokens; configure reverse-proxy access logs separately to avoid recording private room paths. Room pages request that crawlers do not index them.

### Verification

Run `pnpm test` for focused unit and local HTTP/WebSocket protocol regression tests, and `pnpm lint` for static checks. Tests start and stop their own local server and do not use browser automation.

---

**Disclaimer:** This is a simple, minimalist application intended for basic text and image sharing. It is provided as-is and may not be suitable for all use cases, especially those requiring high security or advanced features. Use at your own discretion.
