# Real-time Text & Image Share

A minimalist web application for sharing text and images between devices in real-time, privately and **without persistent storage**.

## Project Description

Real-time Text & Image Share is a simple and privacy-focused web application that allows you to instantly share text and images (PNG, JPG, WEBP) between different devices (desktop, mobile, tablets, etc.). When you open the site, it generates a unique, random URL (using UUID v4). Simply share this URL (e.g., by scanning the QR code) with other devices to create a private, real-time sharing room.

**Key Features:**

* **Real-time Synchronization:** Text and images shared on one device instantly appear on all other connected devices in the same room.
* **Image Sharing:** Upload or drag-and-drop images (PNG, JPG, WEBP) to share with all users in the room. Images are automatically resampled, compressed, and stripped of metadata for privacy and efficiency. Each image displays its dimensions and file size in the UI, and can be downloaded by any user.
* **In-Memory Image Handling (No Disk Storage):** Images are never written to disk. All image processing (resizing, compression, metadata removal) is performed in memory, and images are streamed directly to all connected users via WebSocket. This maximizes privacy and ensures no image files are ever stored on the server.
* **Automatic Image Optimization:** All images are processed on the server to be under 500kB, resized if needed, and have all metadata removed. If an image cannot be compressed below 500kB, the upload is rejected.
* **No Persistent Text/Data Storage:** No text or user data is stored persistently on the server. Text and user presence exist only in memory while users are connected.
* **Privacy Focused:** Designed with privacy in mind. No accounts, no tracking, no persistent server-side storage of your text or images.
* **Minimalist UI:** Clean and simple user interface for easy use on any device.
* **QR Code for Easy Sharing:** A QR code of the unique URL is automatically generated, making it easy to open the same room on mobile devices.
* **User Presence:** Displays the number of connected users and their IP addresses (for transparency within the room).
* **Room Cleanup:** Automatically closes WebSocket connections and frees up server resources when all users disconnect from a room.
* **Rate Limiting:** Uploads are rate-limited globally and per IP to prevent abuse.

## In-Memory Image Privacy Feature

- **No Temp Files:** Images are never written to disk. All uploads are processed and streamed in memory only.
- **Direct Streaming:** Uploaded images are streamed directly to all connected users (including the uploader) using WebSockets, after in-memory processing.
- **Progress & Info:** Both uploaders and downloaders see real-time progress and image info (dimensions, file size) during transfer.
- **Maximum Privacy:** No image data is ever stored on the server, even temporarily. This ensures maximum privacy for all users.
- **See [Images-Transfer-Protocol.md](./Images-Transfer-Protocol.md) for technical details.**

## Technology Stack

* **Backend:**
  * [Node.js](https://nodejs.org/) - JavaScript runtime environment
  * [Express.js](https://expressjs.com/) - Web application framework for Node.js
  * [ws](https://github.com/websockets/ws) - WebSocket library for Node.js
  * [uuid](https://github.com/uuidjs/uuid) - For generating UUID v4 room IDs
  * [multer](https://github.com/expressjs/multer) - For handling file uploads
  * [sharp](https://github.com/lovell/sharp) - For image processing, compression, and metadata stripping
  * [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) - For upload rate limiting
* **Frontend:**
  * HTML5, CSS3, JavaScript (ES6+)
  * [qrcodejs](https://github.com/davidshimjs/qrcodejs) (via CDN) - For client-side QR code generation
* **Templating:**
  * [EJS](https://ejs.co/) - Embedded JavaScript templates

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

4. **Start sharing:**

    - **Text:** Begin typing in the textarea. The text will instantly synchronize with all other devices that are connected to the same URL.
    - **Images:** Upload or drag-and-drop an image file (PNG, JPG, WEBP) into the image sharing area. The image will be optimized and broadcast to all users in the room, showing its dimensions and file size. All users can download the image.

5. **User List:**

    The "Connected Users" section displays the number of users currently in the room and a list of their IP addresses.

6. **To end sharing:**

    Simply close the browser tab or window on all devices. Once all users disconnect, the room is automatically cleared on the server and all images are deleted.

## Privacy Considerations

* **Temporary Image Storage:** Images are stored temporarily on the server filesystem for the duration of the room or up to 15 minutes, then deleted. Images are not stored permanently.
* **IP Address Visibility:**  For transparency, the application displays the IP addresses of all connected users in the room to each other. Please be aware of this if you have privacy concerns about sharing your IP address with others in the room. This is a necessary part of the user presence feature in this minimalist design.
* **No Persistent Text/Data Storage:**  The application is designed to be stateless for text and user presence. No text content, images, or user data is stored on the server persistently.  Data exists only in memory (for text) or temporarily on disk (for images) during active sessions.
* **HTTPS Recommendation:** For enhanced security and privacy, it is strongly recommended to deploy this application with HTTPS enabled to encrypt communication between clients and the server.

---

**Disclaimer:** This is a simple, minimalist application intended for basic text and image sharing. It is provided as-is and may not be suitable for all use cases, especially those requiring high security or advanced features. Use at your own discretion.
