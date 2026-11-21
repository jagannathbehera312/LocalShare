require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const archiver = require('archiver');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const mime = require('mime-types');

const {
  ROOT_DIR,
  UPLOADS_DIR,
  TRASH_DIR,
  resolveSafePath,
  sanitizeFilename,
  getAvailableFilename,
  getFileTypeCategory,
  formatBytes,
  getStorageInfo,
  isBlockedExtension
} = require('./lib/storage');

const db = require('./lib/db');
const chunkManager = require('./lib/chunkManager');
const sse = require('./lib/sse');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'droplite-default-session-secret-change-me';

// Initialize master password and database
const defaultAdminPass = process.env.ADMIN_PASSWORD || 'droplite123';
db.initSettings(defaultAdminPass);

// Initial maintenance run
db.runMaintenance();
chunkManager.cleanStaleSessions();
setInterval(() => {
  db.runMaintenance();
  chunkManager.cleanStaleSessions();
}, 30 * 60 * 1000);

// Multer in-memory storage for chunks and small direct uploads
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB per single chunk / small upload
});

// Configure Helmet for local network HTTP & remote HTTPS tunnels
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: null // CRITICAL: null disables auto-upgrading HTTP to HTTPS on mobile devices
      }
    },
    hsts: false, // CRITICAL: false prevents strict HTTPS requirement on local network IP
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    originAgentCluster: false
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Rate limiter for login endpoint to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});

// ==========================================
// Session & Auth Helpers
// ==========================================
function createAuthToken() {
  const version = db.getSessionVersion();
  const payload = {
    v: version,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
  };
  const str = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(str).digest('hex');
  return `${str}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [str, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(str).digest('hex');
  if (sig !== expectedSig) return false;

  try {
    const payload = JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
    if (Date.now() > payload.exp) return false;
    if (payload.v !== db.getSessionVersion()) return false;
    return true;
  } catch {
    return false;
  }
}

// Middleware to authenticate private API requests
function requireAuth(req, res, next) {
  const token = req.cookies.droplite_token || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (verifyAuthToken(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
}

// ==========================================
// Static Assets & PWA
// ==========================================
app.use(express.static(path.join(ROOT_DIR, 'public'), {
  etag: true,
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('sw.js')) {
      // Never cache the service worker
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Web Share Target API route for Android: redirects to main app with query
app.post('/share-target', uploadMemory.array('shared_files'), (req, res) => {
  // If files were posted via Web Share Target
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const safeName = getAvailableFilename(UPLOADS_DIR, file.originalname);
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), file.buffer);
    }
    sse.broadcast('file_change', { action: 'upload', files: req.files.map(f => f.originalname) });
  } else if (req.body && (req.body.text || req.body.url || req.body.title)) {
    const text = [req.body.title, req.body.text, req.body.url].filter(Boolean).join('\n');
    db.addClip({ text, type: req.body.url ? 'link' : 'text', device: 'Android Share' });
    sse.broadcast('clip_new', { text });
  }
  res.redirect('/?shared=1');
});

// ==========================================
// Authentication Routes
// ==========================================
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  if (db.verifyPassword(password)) {
    const token = createAuthToken();
    res.cookie('droplite_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    return res.json({ success: true, token });
  }

  return res.status(401).json({ error: 'Incorrect password. Please try again.' });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies.droplite_token || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  const isAuthed = verifyAuthToken(token);
  res.json({ authenticated: isAuthed });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('droplite_token');
  res.json({ success: true });
});

app.post('/api/auth/logout-all', requireAuth, (req, res) => {
  db.invalidateAllSessions();
  res.clearCookie('droplite_token');
  res.json({ success: true, message: 'All devices have been logged out' });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters long' });
  }

  if (!db.verifyPassword(currentPassword)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.setPassword(newPassword);
  // Issue new token for current device
  const token = createAuthToken();
  res.cookie('droplite_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });

  res.json({ success: true, message: 'Password changed successfully' });
});

// ==========================================
// Settings & Storage Dashboard Routes
// ==========================================
app.get('/api/settings', requireAuth, (req, res) => {
  res.json(db.getSettings());
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { theme, defaultView, maxUploadSizeMB, autoDeleteDays, trashRetentionDays, blockedExtensions, storageQuotaMB } = req.body;
  const updates = {};

  if (theme) updates.theme = theme;
  if (defaultView) updates.defaultView = defaultView;
  if (typeof maxUploadSizeMB === 'number') updates.maxUploadSizeMB = maxUploadSizeMB;
  if (typeof autoDeleteDays === 'number') updates.autoDeleteDays = autoDeleteDays;
  if (typeof trashRetentionDays === 'number') updates.trashRetentionDays = trashRetentionDays;
  if (typeof storageQuotaMB === 'number') updates.storageQuotaMB = storageQuotaMB;
  if (Array.isArray(blockedExtensions)) updates.blockedExtensions = blockedExtensions;

  const newSettings = db.updateSettings(updates);
  sse.broadcast('settings_change', newSettings);
  res.json({ success: true, settings: newSettings });
});

app.get('/api/storage', requireAuth, (req, res) => {
  const info = getStorageInfo();
  const settings = db.getSettings();
  info.quotaBytes = (settings.storageQuotaMB || 0) * 1024 * 1024;
  info.maxUploadBytes = (settings.maxUploadSizeMB || 51200) * 1024 * 1024;
  res.json(info);
});

// ==========================================
// File Management Routes
// ==========================================
// List contents of a folder
app.get('/api/files', requireAuth, (req, res) => {
  const targetFolderRel = req.query.folder || '';
  try {
    const targetPath = resolveSafePath(UPLOADS_DIR, targetFolderRel);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      try {
        const fullItemPath = path.join(targetPath, entry.name);
        const stat = fs.statSync(fullItemPath);
        const itemRelative = path.relative(UPLOADS_DIR, fullItemPath).replace(/\\/g, '/');
        const isDir = entry.isDirectory();
        const category = isDir ? 'folder' : getFileTypeCategory(entry.name);
        const mimeType = isDir ? null : (mime.lookup(entry.name) || 'application/octet-stream');

        items.push({
          name: entry.name,
          relativePath: itemRelative,
          isDirectory: isDir,
          size: isDir ? null : stat.size,
          formattedSize: isDir ? null : formatBytes(stat.size),
          mtime: stat.mtime,
          category,
          mimeType,
          previewable: ['image', 'video', 'audio', 'document', 'code'].includes(category)
        });
      } catch {
        // Skip inaccessible item
      }
    }

    res.json({
      folder: targetFolderRel.replace(/\\/g, '/'),
      items
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create folder
app.post('/api/folder', requireAuth, (req, res) => {
  const { folder = '', name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Folder name is required' });
  }

  try {
    const parentDir = resolveSafePath(UPLOADS_DIR, folder);
    const safeName = sanitizeFilename(name);
    const newDirPath = path.join(parentDir, safeName);

    if (fs.existsSync(newDirPath)) {
      return res.status(409).json({ error: 'A folder or file with this name already exists' });
    }

    fs.mkdirSync(newDirPath, { recursive: true });
    sse.broadcast('folder_change', { action: 'create', folder, name: safeName });
    res.json({ success: true, name: safeName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rename file or folder
app.post('/api/rename', requireAuth, (req, res) => {
  const { relativePath, newName } = req.body;
  if (!relativePath || !newName) {
    return res.status(400).json({ error: 'Path and new name are required' });
  }

  try {
    const itemPath = resolveSafePath(UPLOADS_DIR, relativePath);
    if (!fs.existsSync(itemPath)) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const safeNewName = sanitizeFilename(newName);
    const parentDir = path.dirname(itemPath);
    const newFullPath = path.join(parentDir, safeNewName);

    if (fs.existsSync(newFullPath) && newFullPath.toLowerCase() !== itemPath.toLowerCase()) {
      return res.status(409).json({ error: 'An item with this name already exists' });
    }

    fs.renameSync(itemPath, newFullPath);
    sse.broadcast('file_change', { action: 'rename', oldPath: relativePath, newName: safeNewName });
    res.json({ success: true, newName: safeNewName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Move items into a destination folder
app.post('/api/move', requireAuth, (req, res) => {
  const { items, destinationFolder = '' } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items specified to move' });
  }

  try {
    const destDir = resolveSafePath(UPLOADS_DIR, destinationFolder);
    if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
      return res.status(404).json({ error: 'Destination folder does not exist' });
    }

    const moved = [];
    for (const relPath of items) {
      try {
        const sourcePath = resolveSafePath(UPLOADS_DIR, relPath);
        if (!fs.existsSync(sourcePath)) continue;

        // Prevent moving a folder into itself
        if (destDir.startsWith(sourcePath + path.sep) || destDir === sourcePath) {
          continue;
        }

        const itemName = path.basename(sourcePath);
        let targetPath = path.join(destDir, itemName);

        // If duplicate in target, get available name
        if (fs.existsSync(targetPath)) {
          const availName = getAvailableFilename(destDir, itemName);
          targetPath = path.join(destDir, availName);
        }

        fs.renameSync(sourcePath, targetPath);
        moved.push(relPath);
      } catch (e) {
        console.error('Error moving item:', relPath, e.message);
      }
    }

    sse.broadcast('file_change', { action: 'move', moved, destinationFolder });
    res.json({ success: true, movedCount: moved.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// Trash Routes (Soft-delete & Auto-purge)
// ==========================================
// Move files/folders to Trash
app.post('/api/trash', requireAuth, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items specified for trash' });
  }

  const trashed = [];
  for (const relPath of items) {
    try {
      const sourcePath = resolveSafePath(UPLOADS_DIR, relPath);
      if (!fs.existsSync(sourcePath)) continue;

      const stat = fs.statSync(sourcePath);
      const isDir = stat.isDirectory();
      const trashId = crypto.randomBytes(8).toString('hex');
      const ext = isDir ? '' : path.extname(sourcePath);
      const trashFileName = `${trashId}${ext}`;
      const destTrashPath = path.join(TRASH_DIR, trashFileName);

      fs.renameSync(sourcePath, destTrashPath);

      const trashMeta = db.addTrashItem({
        id: trashId,
        originalPath: relPath,
        trashFileName,
        name: path.basename(sourcePath),
        isDirectory: isDir,
        size: isDir ? 0 : stat.size
      });

      trashed.push(trashMeta);
    } catch (e) {
      console.error('Error moving item to trash:', relPath, e.message);
    }
  }

  sse.broadcast('trash_change', { action: 'add', count: trashed.length });
  sse.broadcast('file_change', { action: 'delete' });
  res.json({ success: true, trashedCount: trashed.length });
});

// List items currently in Trash
app.get('/api/trash', requireAuth, (req, res) => {
  const items = db.getTrashItems().map(item => ({
    ...item,
    formattedSize: item.isDirectory ? 'Folder' : formatBytes(item.size)
  }));
  res.json({ items });
});

// Restore item from Trash
app.post('/api/trash/restore', requireAuth, (req, res) => {
  const { id } = req.body;
  const item = db.getTrashItem(id);
  if (!item) {
    return res.status(404).json({ error: 'Trash item not found' });
  }

  try {
    const trashFilePath = path.join(TRASH_DIR, item.trashFileName);
    if (!fs.existsSync(trashFilePath)) {
      db.removeTrashItem(id);
      return res.status(404).json({ error: 'File no longer exists in trash' });
    }

    // Determine target restore location
    let targetPath = resolveSafePath(UPLOADS_DIR, item.originalPath);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Check if filename is already occupied
    if (fs.existsSync(targetPath)) {
      const availName = getAvailableFilename(targetDir, item.name);
      targetPath = path.join(targetDir, availName);
    }

    fs.renameSync(trashFilePath, targetPath);
    db.removeTrashItem(id);

    sse.broadcast('trash_change', { action: 'restore', id });
    sse.broadcast('file_change', { action: 'restore' });
    res.json({ success: true, restoredName: path.basename(targetPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete single item permanently from Trash
app.delete('/api/trash/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const item = db.removeTrashItem(id);
  if (item) {
    const trashFilePath = path.join(TRASH_DIR, item.trashFileName);
    try {
      if (fs.existsSync(trashFilePath)) {
        fs.rmSync(trashFilePath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('Error removing file permanently from trash:', e.message);
    }
  }

  sse.broadcast('trash_change', { action: 'delete', id });
  res.json({ success: true });
});

// Empty entire Trash permanently
app.post('/api/trash/empty', requireAuth, (req, res) => {
  const items = db.clearTrashItems();
  for (const item of items) {
    const trashFilePath = path.join(TRASH_DIR, item.trashFileName);
    try {
      if (fs.existsSync(trashFilePath)) {
        fs.rmSync(trashFilePath, { recursive: true, force: true });
      }
    } catch (e) {
      // ignore
    }
  }

  sse.broadcast('trash_change', { action: 'empty' });
  res.json({ success: true, count: items.length });
});

// ==========================================
// Upload Routes (Direct + Resumable Chunked)
// ==========================================
// Direct upload for small files or mobile photo capture
app.post('/api/upload', requireAuth, uploadMemory.array('files'), (req, res) => {
  const targetFolder = req.body.folder || '';
  const conflictAction = req.body.conflictAction || 'rename';
  const settings = db.getSettings();

  try {
    const destDir = resolveSafePath(UPLOADS_DIR, targetFolder);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const savedFiles = [];

    for (const file of (req.files || [])) {
      // Check blocked extensions
      if (isBlockedExtension(file.originalname, settings.blockedExtensions)) {
        return res.status(400).json({ error: `File type '${path.extname(file.originalname)}' is blocked for security.` });
      }

      let finalName = sanitizeFilename(file.originalname);
      const targetFilePath = path.join(destDir, finalName);

      if (fs.existsSync(targetFilePath)) {
        if (conflictAction === 'skip') {
          continue;
        } else if (conflictAction === 'rename') {
          finalName = getAvailableFilename(destDir, finalName);
        }
      }

      fs.writeFileSync(path.join(destDir, finalName), file.buffer);
      savedFiles.push(finalName);
    }

    sse.broadcast('file_change', { action: 'upload', files: savedFiles });
    res.json({ success: true, savedFiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chunked Upload: Init session
app.post('/api/upload/init', requireAuth, (req, res) => {
  const { uploadId, fileName, fileSize, totalChunks, relativePath, conflictAction } = req.body;
  if (!uploadId || !fileName || !totalChunks) {
    return res.status(400).json({ error: 'Missing required upload parameters' });
  }

  const settings = db.getSettings();
  if (isBlockedExtension(fileName, settings.blockedExtensions)) {
    return res.status(400).json({ error: `File type '${path.extname(fileName)}' is blocked for security.` });
  }

  // Check max upload size
  const maxBytes = (settings.maxUploadSizeMB || 51200) * 1024 * 1024;
  if (parseInt(fileSize, 10) > maxBytes) {
    return res.status(400).json({ error: `File exceeds maximum allowed upload size (${settings.maxUploadSizeMB} MB)` });
  }

  const session = chunkManager.initSession({
    uploadId,
    fileName,
    fileSize,
    totalChunks,
    relativePath,
    conflictAction
  });

  res.json({ success: true, session });
});

// Chunked Upload: Check status / Resume inquiry
app.get('/api/upload/status', requireAuth, (req, res) => {
  const { uploadId } = req.query;
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });

  const status = chunkManager.getSessionStatus(uploadId);
  if (!status) return res.status(404).json({ error: 'Upload session not found' });
  res.json(status);
});

// Chunked Upload: Upload single chunk
app.post('/api/upload/chunk', requireAuth, uploadMemory.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  if (!uploadId || chunkIndex === undefined || !req.file) {
    return res.status(400).json({ error: 'Missing chunk parameters or file data' });
  }

  try {
    chunkManager.saveChunk(uploadId, parseInt(chunkIndex, 10), req.file.buffer);
    res.json({ success: true, chunkIndex: parseInt(chunkIndex, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chunked Upload: Complete & Assemble
app.post('/api/upload/complete', requireAuth, async (req, res) => {
  const { uploadId, targetFolder = '', conflictAction } = req.body;
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });

  try {
    const result = await chunkManager.assembleChunks({
      uploadId,
      targetFolder,
      conflictAction
    });

    sse.broadcast('file_change', { action: 'upload', file: result.fileName });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Download & Preview Routes
// ==========================================
// Helper to set Content-Disposition with RFC 5987 / 6266 encoding for iOS & Android
function setDownloadHeaders(res, filename, mimeType) {
  const encodedName = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_');

  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
  );
}

// Single file download (with Range support for resumed downloads & audio/video)
app.get('/api/download/:path(*)', requireAuth, (req, res) => {
  const relPath = req.params.path;
  try {
    const fullPath = resolveSafePath(UPLOADS_DIR, relPath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a folder directly as a single file. Use ZIP download.' });
    }

    const filename = path.basename(fullPath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';

    setDownloadHeaders(res, filename, mimeType);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Multi-select download as ZIP
app.post('/api/download-zip', requireAuth, (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'No files specified to download' });
  }

  const zipName = `droplite-download-${Date.now()}.zip`;
  setDownloadHeaders(res, zipName, 'application/zip');

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => {
    console.error('ZIP archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate ZIP archive' });
    }
  });

  archive.pipe(res);

  for (const relPath of paths) {
    try {
      const fullPath = resolveSafePath(UPLOADS_DIR, relPath);
      if (!fs.existsSync(fullPath)) continue;

      const stat = fs.statSync(fullPath);
      const entryName = path.basename(fullPath);

      if (stat.isDirectory()) {
        archive.directory(fullPath, entryName);
      } else {
        archive.file(fullPath, { name: entryName });
      }
    } catch (e) {
      console.error('Error adding file to zip:', relPath, e.message);
    }
  }

  archive.finalize();
});

// Inline Preview route with HTTP 206 Partial Content (essential for iOS Safari video streaming)
app.get('/api/preview/:path(*)', requireAuth, (req, res) => {
  const relPath = req.params.path;
  try {
    const fullPath = resolveSafePath(UPLOADS_DIR, relPath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).send('Not found');
    }

    const stat = fs.statSync(fullPath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    const range = req.headers.range;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

      if (start >= stat.size || end >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).send('Requested range not satisfiable');
      }

      const chunksize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType
      });

      fs.createReadStream(fullPath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(fullPath).pipe(res);
    }
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// View text/code content
app.get('/api/view-text/:path(*)', requireAuth, (req, res) => {
  const relPath = req.params.path;
  try {
    const fullPath = resolveSafePath(UPLOADS_DIR, relPath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'File is too large to preview as text (> 2MB)' });
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({ content, filename: path.basename(fullPath), size: stat.size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// Quick Send (Clips) Routes
// ==========================================
app.get('/api/clips', requireAuth, (req, res) => {
  res.json(db.getClips());
});

app.post('/api/clips', requireAuth, (req, res) => {
  const { text, type = 'text', device = 'Web Browser' } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text cannot be empty' });
  }

  const clip = db.addClip({ text, type, device });
  sse.broadcast('clip_new', clip);
  res.json({ success: true, clip });
});

app.delete('/api/clips/:id', requireAuth, (req, res) => {
  const success = db.deleteClip(req.params.id);
  if (success) {
    sse.broadcast('clip_delete', { id: req.params.id });
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Clip not found' });
});

app.post('/api/clips/clear', requireAuth, (req, res) => {
  db.clearClips();
  sse.broadcast('clip_clear');
  res.json({ success: true });
});

// ==========================================
// Share Links Routes
// ==========================================
// List shares
app.get('/api/shares', requireAuth, (req, res) => {
  res.json(db.listShares());
});

// Create share link
app.post('/api/shares', requireAuth, (req, res) => {
  const { path: targetRelPath, expiryHours, password, downloadLimit } = req.body;
  if (!targetRelPath) return res.status(400).json({ error: 'Path is required' });

  try {
    const fullPath = resolveSafePath(UPLOADS_DIR, targetRelPath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const stat = fs.statSync(fullPath);
    const isDir = stat.isDirectory();
    const fileName = path.basename(fullPath);

    const share = db.createShare({
      targetRelativePath: targetRelPath,
      fileName,
      isDirectory: isDir,
      fileSize: isDir ? 0 : stat.size,
      expiryHours: parseInt(expiryHours, 10) || 0,
      password,
      downloadLimit: parseInt(downloadLimit, 10) || 0
    });

    res.json({ success: true, share });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete / Revoke share link
app.delete('/api/shares/:id', requireAuth, (req, res) => {
  const success = db.deleteShare(req.params.id);
  if (success) return res.json({ success: true });
  res.status(404).json({ error: 'Share link not found' });
});

// Standalone public share HTML page
app.get('/share/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'share.html'));
});

// Public share details query
app.get('/api/public/share/:id', (req, res) => {
  const share = db.getShare(req.params.id);
  if (!share) {
    return res.status(404).json({ error: 'Share link is expired or does not exist' });
  }

  // Do not expose password hash to client
  const { passwordHash, ...publicData } = share;
  publicData.formattedSize = share.isDirectory ? 'Folder' : formatBytes(share.fileSize);
  publicData.category = share.isDirectory ? 'folder' : getFileTypeCategory(share.fileName);
  res.json(publicData);
});

// Public download shared item
app.all('/api/public/share/:id/download', (req, res) => {
  const share = db.getShare(req.params.id);
  if (!share) {
    return res.status(404).json({ error: 'Share link is expired or invalid' });
  }

  // Password verification if required
  if (share.hasPassword) {
    const clientPass = req.query.password || (req.body && req.body.password);
    const bcrypt = require('bcryptjs');
    if (!clientPass || !bcrypt.compareSync(clientPass, share.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect password for this share link' });
    }
  }

  try {
    const fullPath = resolveSafePath(UPLOADS_DIR, share.targetRelativePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Shared file no longer exists on the server' });
    }

    db.incrementShareDownload(share.id);

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Archive folder as zip
      const zipName = `${share.fileName}.zip`;
      setDownloadHeaders(res, zipName, 'application/zip');
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(res);
      archive.directory(fullPath, share.fileName);
      archive.finalize();
    } else {
      const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
      setDownloadHeaders(res, share.fileName, mimeType);
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(fullPath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public preview shared item (for images/videos/audio/pdf)
app.all('/api/public/share/:id/preview', (req, res) => {
  const share = db.getShare(req.params.id);
  if (!share) {
    return res.status(404).send('Share link expired');
  }

  if (share.hasPassword) {
    const clientPass = req.query.password || (req.body && req.body.password);
    const bcrypt = require('bcryptjs');
    if (!clientPass || !bcrypt.compareSync(clientPass, share.passwordHash)) {
      return res.status(401).send('Password required');
    }
  }

  try {
    const fullPath = resolveSafePath(UPLOADS_DIR, share.targetRelativePath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).send('Not found');
    }

    const stat = fs.statSync(fullPath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ==========================================
// Live Sync (SSE) Route
// ==========================================
app.get('/api/events', requireAuth, (req, res) => {
  sse.addClient(req, res);
});

// Generate QR Code as SVG directly
app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text) {
    return res.status(400).send('Text parameter is required');
  }
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Network LAN information endpoint
app.get('/api/lan-info', (req, res) => {
  const netAddresses = getLocalNetworkAddresses();
  const primaryLanIp = netAddresses.length > 0 ? netAddresses[0].address : 'localhost';
  const lanUrl = `http://${primaryLanIp}:${PORT}`;
  const localUrl = `http://localhost:${PORT}`;

  res.json({
    port: PORT,
    primaryLanIp,
    lanUrl,
    localUrl,
    allInterfaces: netAddresses.map(net => ({
      name: net.interface,
      ip: net.address,
      url: `http://${net.address}:${PORT}`
    }))
  });
});

// ==========================================
// Network LAN Discovery & Server Startup
// ==========================================
function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Pick IPv4 and non-internal
      if (net.family === 'IPv4' && !net.internal) {
        let score = 50;
        const lowerName = name.toLowerCase();

        // Highest priority: real physical Wi-Fi or Wireless adapters
        if (/wi-?fi|wlan|wireless|airport/i.test(lowerName)) {
          score = 100;
        } 
        // Second priority: physical Ethernet adapters
        else if (/ethernet|eth\d|en\d/i.test(lowerName) && !/veth/i.test(lowerName)) {
          score = 80;
        }
        // Lowest priority: virtual, VM, docker, WSL, loopback adapters
        else if (/vmware|virtual|vbox|vethernet|docker|wsl|loopback|tailscale|hyper-v|pseudo/i.test(lowerName)) {
          score = -50;
        }

        addresses.push({ interface: name, address: net.address, score });
      }
    }
  }

  // Sort descending by score so physical Wi-Fi is always first
  addresses.sort((a, b) => b.score - a.score);
  return addresses;
}

function startServer(port = PORT, host = HOST) {
  return app.listen(port, host, () => {
    const netAddresses = getLocalNetworkAddresses();
    const primaryLanIp = netAddresses.length > 0 ? netAddresses[0].address : 'localhost';
    const lanUrl = `http://${primaryLanIp}:${port}`;
    const localUrl = `http://localhost:${port}`;

    console.log('\n=============================================================');
    console.log('   🚀  DropLite - Personal Cloud & Local File Transfer');
    console.log('=============================================================');
    console.log(`  Local URL:        ${localUrl}`);
    console.log(`  LAN Network URL:  ${lanUrl}`);
    if (netAddresses.length > 1) {
      console.log('  Other LAN IPs:');
      netAddresses.slice(1).forEach(net => {
        console.log(`    - ${net.interface}: http://${net.address}:${port}`);
      });
    }
    console.log('-------------------------------------------------------------');
    console.log('  Scan this QR code with your phone (Android / iOS):');
    console.log('');
    qrcodeTerminal.generate(lanUrl, { small: true });
    console.log('-------------------------------------------------------------');
    console.log(`  Files saved to:   ${UPLOADS_DIR}`);
    console.log(`  Admin Password:   ${process.env.ADMIN_PASSWORD || 'droplite123'}`);
    console.log('=============================================================\n');
  });
}

let serverInstance = null;
if (require.main === module) {
  serverInstance = startServer();
}

// Export app and server starter for testing
module.exports = { app, startServer, getLocalNetworkAddresses };
