<div align="center">

  <img src="public/assets/icon.svg" width="110" height="110" alt="DropLite Logo" style="border-radius: 24px; box-shadow: 0 10px 25px rgba(99, 102, 241, 0.4);" />

  # ⚡ DropLite

  ### Beautiful, Self-Hosted Personal Cloud & Fast Local File Transfer
  **Send files seamlessly between your PC, Mac, Linux, Android, and iOS devices on local Wi-Fi.**  
  *No cloud subscriptions. No size limits. No database required. No build step.*

  <br />

  [![Node.js Version](https://img.shields.io/badge/Node.js-18%2B%20%7C%2020%2B%20%7C%2022%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![Express.js](https://img.shields.io/badge/Express-4.21-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
  [![PWA Ready](https://img.shields.io/badge/PWA-Installable-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
  [![Database](https://img.shields.io/badge/Database-Zero_Config_(JSON)-10b981?style=for-the-badge&logo=json&logoColor=white)](#-zero-database-architecture)
  [![License: MIT](https://img.shields.io/badge/License-MIT-6366f1?style=for-the-badge)](LICENSE)

  <br />

  <p align="center">
    <a href="#-quick-start"><b>Quick Start</b></a> •
    <a href="#-features"><b>Features</b></a> •
    <a href="#-screenshots--demo"><b>Demo</b></a> •
    <a href="#-mobile-experience--pwa"><b>Mobile PWA</b></a> •
    <a href="#-platform-guides"><b>OS Guides</b></a> •
    <a href="#-remote-access-internet"><b>Remote Access</b></a> •
    <a href="#-configuration"><b>Config</b></a>
  </p>

</div>

---

## 💡 Why DropLite?

Most file transfer apps either require third-party cloud servers (where your data is stored externally), complicated setups with Docker and PostgreSQL, or lack seamless mobile integration.

**DropLite** is designed to be the ultimate local dropzone:
- 📱 **Zero App Store Installs:** Open in Safari, Chrome, or Edge on any phone or laptop.
- 📦 **No Build Steps:** Plain Node.js backend + Vanilla HTML/CSS/JS frontend. Just `npm install && npm start`.
- 🗄️ **Zero Database:** Files live directly in an `uploads/` folder on your hard drive. Metadata lives in a lightweight atomic JSON file.
- ⚡ **Multi-Gigabyte Resumable Uploads:** Handles massive 10GB–50GB+ files in streaming 5MB chunks. If Wi-Fi blips, it pauses and resumes automatically without starting over.
- 📲 **Native Android Share Target:** Share photos and files directly from your phone's Gallery app straight into DropLite!

---

## ✨ Features

<div align="center">

| Feature | Description |
| :--- | :--- |
| **🚀 Chunked Resumable Uploads** | Multi-GB file streaming with speed meters (MB/s), ETA calculations, and pause/resume. |
| **📂 Whole-Folder Transfers** | Drag and drop entire folder trees or upload directories preserving subfolders. |
| **⚡ Live Cross-Device Sync** | Server-Sent Events (SSE) instantly refresh all open devices when files are added or deleted. |
| **📋 Quick Send Clipboard** | Instant real-time clipboard sharing: paste a note/URL on your PC and copy it on your phone. |
| **📥 Multi-Select ZIP Streaming** | Pick multiple files or folders and stream-download them as a single ZIP on the fly. |
| **🔗 Expiring Share Links** | Create public download links with custom expiry (*1h, 24h, 7d, never*), passwords & download caps. |
| **📱 Mobile-First PWA** | Installable app shell, bottom navigation, floating action button, and Android Web Share Target. |
| **👁️ Fullscreen Lightbox** | Preview photos, play videos/audio with HTTP 206 seeking, read PDFs, or view code with syntax styling. |
| **🗑️ Safe Trash & Auto-Purge** | Soft-delete with 1-click restore. Files in Trash automatically purge after 30 days. |
| **🛡️ Hardened Security** | Path traversal protection, helmet headers, login rate limiting, and blocked executable extensions. |

</div>

---

## 🖥️ Terminal Experience & Startup

When you launch DropLite, it automatically detects your **physical Wi-Fi network interface** and renders a **scannable QR code** right in your terminal:

```text
=============================================================
   🚀  DropLite - Personal Cloud & Local File Transfer
=============================================================
  Local URL:        http://localhost:5000
  LAN Network URL:  http://192.168.1.14:5000
-------------------------------------------------------------
  Scan this QR code with your phone (Android / iOS):

  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █▄▄▄ ▀ ▀█▄█ ▄▄▄▄▄ █
  █ █   █ ██▄▀ █  ▀▀█ █   █ █
  █ █▄▄▄█ ██▀▄ ▄█▀███ █▄▄▄█ █
  █▄▄▄▄▄▄▄█ ▀▄█ ▀ █▄█▄▄▄▄▄▄▄█
  █▄ █▄ ▀▄█▀▄▀█▄▀█ ▀▀▄█▀▀▀▀▄█
  ███▀ ██▄▀█▄██▄▄▄ █ ▄▄  ▀▀ █
  █▀██▀▄▄▄ █▄ █▀▀▄▀▄▄▄▀▀██▀▄█
  █ ▄ ▄█▀▄▄█▄▀█▀▄▄▄ ▄██▀▄ ▄ █
  █▄███▄▄▄█ ▀▀ ▄▄ ▀ ▄▄▄ █▄ ██
  █ ▄▄▄▄▄ ██▄ ▀▄  █ █▄█ ▄██ █
  █ █   █ █ ▀█▄ ██▄▄▄  ▄ █▀▀█
  █ █▄▄▄█ █▀▀▄ ▀█▄▀█▀▀▀ █   █
  █▄▄▄▄▄▄▄█▄▄▄▄██▄▄▄█▄██▄██▄█

-------------------------------------------------------------
  Files saved to:   C:\Users\...\LocalShare\uploads
  Admin Password:   droplite123
=============================================================
```

> **Just point your phone's camera at your screen** — it connects instantly!

---

## ⚡ Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) v18.0.0 or higher
- Git (optional)

### 1. Clone & Install
```bash
git clone https://github.com/yourusername/droplite.git
cd droplite
npm install
```

### 2. Verify Your Setup
Run the built-in 11-step end-to-end verification test suite:
```bash
npm test
```

### 3. Start the Server
```bash
npm start
```
Open `http://localhost:5000` on your computer or open the printed `http://192.168.x.x:5000` on your phone!

---

## 📱 Mobile Experience & PWA

DropLite is built from the ground up for mobile screens:

<div align="center">

```
  ┌─────────────────────────┐
  │ 🔍 Search files...   🌙 │
  ├─────────────────────────┤
  │ [All] [Photos] [Videos] │
  │                         │
  │ ┌───────┐  ┌───────┐    │
  │ │ 🖼️    │  │ 🎬    │    │
  │ │IMG_01 │  │VID_02 │    │
  │ └───────┘  └───────┘    │
  │                         │
  │                     (+) │ <-- Floating Upload FAB
  ├─────────────────────────┤
  │ 📁Files ⚡Quick 🗑️Trash │ <-- Bottom Navigation
  └─────────────────────────┘
```

</div>

### 🤖 Android (Chrome / Brave)
1. Navigate to the local URL.
2. Tap the three dots menu (⋮) -> **"Install app"** or **"Add to Home screen"**.
3. **Web Share Target Integration:** Open your gallery or file manager, select any photo, tap **Share**, and choose **DropLite** to upload directly!

### 🍏 iOS (iPhone & iPad Safari)
1. Open the URL in Safari.
2. Tap the **Share** button (box with an arrow pointing upward).
3. Scroll down and tap **"Add to Home Screen"**.
4. DropLite will now launch full-screen like a native iOS app without browser toolbars.

---

## 💻 Platform Guides

<details>
<summary><b>🪟 Windows Setup</b></summary>

1. Open PowerShell or Command Prompt in the project folder:
   ```powershell
   cd C:\path\to\droplite
   npm start
   ```
2. **Firewall Tip:** If your phone cannot connect to your PC, allow port 5000 in Windows Defender Firewall:
   ```powershell
   # Run in PowerShell as Administrator:
   New-NetFirewallRule -DisplayName "DropLite" -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow
   ```
3. **Run on Windows Boot (Optional):** Create a shortcut of a `.bat` file containing `npm start` in your Windows Startup directory (`Win + R` -> `shell:startup`).

</details>

<details>
<summary><b>🍎 macOS Setup</b></summary>

1. Open Terminal:
   ```bash
   cd ~/path/to/droplite
   npm start
   ```
2. If macOS prompts: *"Do you want the application 'node' to accept incoming network connections?"*, click **Allow**.
3. To find your Wi-Fi IP address manually:
   ```bash
   ipconfig getifaddr en0
   ```

</details>

<details>
<summary><b>🐧 Linux & Raspberry Pi (systemd Service)</b></summary>

1. Run directly:
   ```bash
   cd /path/to/droplite
   npm start
   ```
2. **Configure as an auto-starting background daemon:**
   Create `/etc/systemd/system/droplite.service`:
   ```ini
   [Unit]
   Description=DropLite Personal Cloud Service
   After=network.target

   [Service]
   Type=simple
   User=yourusername
   WorkingDirectory=/path/to/droplite
   ExecStart=/usr/bin/npm start
   Restart=always
   RestartSec=5
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```
3. Enable and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now droplite
   ```
4. **Firewall (UFW):**
   ```bash
   sudo ufw allow 5000/tcp
   ```

</details>

---

## 🌐 Remote Access (Internet & HTTPS)

Want to upload photos from outside your home or share download links with friends across the world? Two free options give you secure HTTPS:

### Option 1: Cloudflare Tunnel *(Recommended — Free HTTPS Subdomain)*
Cloudflare Tunnel exposes DropLite over a secure public HTTPS URL with **zero port forwarding**. Because it provides HTTPS, the **PWA installation** and **Android Web Share Target** will work anywhere in the world!

1. Install `cloudflared` ([Official Downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
2. Start the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:5000
   ```
3. Cloudflare gives you a secure URL like `https://your-custom-name.trycloudflare.com` that you can open on any phone anywhere!

### Option 2: Tailscale *(Private Encrypted Mesh VPN)*
If you want only your own devices to access DropLite remotely:
1. Install [Tailscale](https://tailscale.com) on your PC and mobile devices.
2. Connect to your PC's 100.x.y.z IP:
   ```text
   http://100.x.y.z:5000
   ```
3. *(Optional)* Turn on automatic HTTPS with Tailscale Serve:
   ```bash
   tailscale serve https / http://localhost:5000
   ```

---

## 📁 Zero-Database Architecture

```text
droplite/
├── .env                  # Environment configuration
├── package.json          # Dependencies & scripts
├── server.js             # Express server, security, streaming & routes
├── test-server.js        # Automated verification test suite
├── lib/
│   ├── chunkManager.js   # Resumable multi-GB chunk streaming & assembly
│   ├── db.js             # Atomic JSON store for settings, shares, clips, trash
│   ├── sse.js            # Server-Sent Events live sync broadcaster
│   └── storage.js        # Disk space inspection, safe path resolution, MIME detection
├── public/
│   ├── index.html        # Main app UI (responsive layout, sidebar & bottom nav)
│   ├── share.html        # Standalone public share landing page
│   ├── manifest.json     # PWA manifest (with Web Share Target)
│   ├── sw.js             # Service Worker for offline app shell caching
│   ├── css/style.css     # Glassmorphic styling (dark/light theme)
│   ├── js/app.js         # Pure Vanilla JS application logic & uploader
│   └── assets/           # Scalable SVG icons & branding
├── uploads/              # Your live files & folders
├── trash/                # Soft-deleted items
├── temp_chunks/          # Temporary chunk staging during multi-GB uploads
└── data/store.json       # Lightweight JSON database
```

---

## ⚙️ Configuration Reference

Edit `.env` to configure your preferences:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `5000` | Port for the HTTP server to bind to |
| `HOST` | `0.0.0.0` | Binds to all network interfaces so Wi-Fi devices can connect |
| `ADMIN_PASSWORD` | `droplite123` | Master password to unlock DropLite (hashed with bcrypt) |
| `SESSION_SECRET` | *(random)* | Key used to sign session tokens |
| `MAX_UPLOAD_SIZE_MB` | `51200` | Maximum allowed single upload size (default 50 GB) |
| `STORAGE_QUOTA_MB` | `0` | Optional storage limit in MB (`0` = full disk capacity) |
| `AUTO_DELETE_DAYS` | `0` | Automatically remove uploads older than N days (`0` = disabled) |
| `TRASH_RETENTION_DAYS` | `30` | Number of days deleted items stay in trash before auto-purge |
| `BLOCKED_EXTENSIONS` | `.exe,.bat,...` | Blocked dangerous executable extensions |

---

## 🛡️ Security & Privacy

- **No Remote Telemetry:** DropLite never phones home or reports data to external servers.
- **Path Traversal Protection:** User-supplied paths are validated with `resolveSafePath()`, disallowing null bytes and directory traversal (`../`).
- **Session Protection:** Session tokens use `HttpOnly` and `SameSite=Lax` cookies with versioning (enabling "Log Out All Devices").
- **Rate-Limited Logins:** Prevents brute-force attempts on the master password.
- **Safe Filename Sanitization:** Reserved OS characters and control characters are stripped while preserving international Unicode scripts (Japanese, Cyrillic, Arabic, Accents, etc.).

---

## 🧪 Testing

DropLite includes a comprehensive automated test suite covering all 11 core functional modules:

```bash
npm test
```

```text
✓ Test 1: Static HTML serving & PWA shell
✓ Test 2: Master password authentication & session cookies
✓ Test 3: Storage info and disk space inspection
✓ Test 4: LAN network discovery & SVG QR code generation
✓ Test 5: Quick Send clips CRUD
✓ Test 6: Folder creation
✓ Test 7: Chunked resumable multi-GB upload assembly
✓ Test 8: Single file download with RFC 5987 headers
✓ Test 9: Public share links, password verification & downloads
✓ Test 10: Trash soft-delete and restore
✓ Test 11: Multi-select streaming ZIP generation
```

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!  
Feel free to check out the [issues page](https://github.com/yourusername/droplite/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.

<div align="center">
  <sub>Built with ❤️ for simple, private, fast personal computing.</sub>
</div>
