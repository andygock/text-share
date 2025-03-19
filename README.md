# Real-time Text Share

A minimalist web application for sharing text between devices in real-time, privately and without data persistence.

## Project Description

Real-time Text Share is a simple and privacy-focused web application that allows you to instantly share text between different devices (desktop, mobile, tablets, etc.).  When you open the site, it generates a unique, random URL (using UUID v4).  Simply share this URL (e.g., by scanning the QR code) with other devices to create a private, real-time text sharing room.

**Key Features:**

* **Real-time Synchronization:** Text typed in one device's textarea instantly appears on all other connected devices in the same room.
* **No Data Persistence:**  Absolutely no text or user data is stored on the server. Everything is transient and exists only in memory while users are connected. Once all users disconnect, the room and its data are automatically cleared.
* **Privacy Focused:** Designed with privacy in mind. No accounts, no tracking, no server-side storage of your text.
* **Minimalist UI:** Clean and simple user interface for easy use on any device.
* **QR Code for Easy Sharing:**  A QR code of the unique URL is automatically generated, making it easy to open the same room on mobile devices.
* **User Presence:** Displays the number of connected users and their IP addresses (for transparency within the room).
* **Room Cleanup:** Automatically closes WebSocket connections and frees up server resources when all users disconnect from a room.

## Technology Stack

* **Backend:**
  * [Node.js](https://nodejs.org/) - JavaScript runtime environment
  * [Express.js](https://expressjs.com/) - Web application framework for Node.js
  * [ws](https://github.com/websockets/ws) - WebSocket library for Node.js
  * [uuid](https://github.com/uuidjs/uuid) - For generating UUID v4 room IDs
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
    * **Scan the QR code:** Use a QR code scanner app on your mobile device to scan the QR code displayed on the page. This will open the same URL in your mobile browser.
    * **Manually type or copy the URL:**  Share the full URL (e.g., `http://localhost:3000/[uuid]`) with anyone you want to share text with.

4. **Start typing:**
    Begin typing in the textarea. The text will instantly synchronize with all other devices that are connected to the same URL.

5. **User List:**
    The "Connected Users" section displays the number of users currently in the room and a list of their IP addresses.

6. **To end sharing:**
    Simply close the browser tab or window on all devices. Once all users disconnect, the room is automatically cleared on the server.

## Privacy Considerations

* **IP Address Visibility:**  For transparency, the application displays the IP addresses of all connected users in the room to each other. Please be aware of this if you have privacy concerns about sharing your IP address with others in the room. This is a necessary part of the user presence feature in this minimalist design.
* **No Data Storage:**  The application is designed to be completely stateless. No text content or user data is stored on the server persistently.  Data exists only in memory during active sessions.
* **HTTPS Recommendation:** For enhanced security and privacy, it is strongly recommended to deploy this application with HTTPS enabled to encrypt communication between clients and the server.

---

**Disclaimer:** This is a simple, minimalist application intended for basic text sharing. It is provided as-is and may not be suitable for all use cases, especially those requiring high security or advanced features. Use at your own discretion.
