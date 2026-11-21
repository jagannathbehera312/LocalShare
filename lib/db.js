const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DATA_DIR, UPLOADS_DIR, TRASH_DIR } = require('./storage');

const DB_FILE = path.join(DATA_DIR, 'store.json');
const DEFAULT_RETENTION_DAYS = 30;

// Default initial state
const defaultState = {
  settings: {
    adminPasswordHash: '', // Initialized on start if empty
    sessionVersion: 1,
    theme: 'system',
    defaultView: 'grid',
    maxUploadSizeMB: 51200, // 50GB
    storageQuotaMB: 0, // 0 = unlimited
    autoDeleteDays: 0, // 0 = disabled
    trashRetentionDays: 30,
    blockedExtensions: ['.exe', '.bat', '.cmd', '.sh', '.vbs', '.msi', '.scr', '.com', '.ps1']
  },
  shares: {},
  clips: [],
  trash: []
};

let memoryStore = null;

function loadStore() {
  if (memoryStore) return memoryStore;
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      memoryStore = JSON.parse(raw);
    } else {
      memoryStore = { ...defaultState };
      saveStore();
    }
  } catch (err) {
    console.error('Warning: could not read store.json, using defaults:', err.message);
    memoryStore = { ...defaultState };
    saveStore();
  }
  return memoryStore;
}

function saveStore() {
  try {
    const tempFile = path.join(DATA_DIR, `store_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`);
    fs.writeFileSync(tempFile, JSON.stringify(memoryStore, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('Error saving store.json:', err);
  }
}

/**
 * Initializes settings with master password from .env if needed
 */
function initSettings(defaultPassword = 'droplite123') {
  const store = loadStore();
  if (!store.settings.adminPasswordHash) {
    const salt = bcrypt.genSaltSync(10);
    store.settings.adminPasswordHash = bcrypt.hashSync(defaultPassword, salt);
    saveStore();
  }
}

// === Settings ===
function getSettings() {
  const store = loadStore();
  // Never expose password hash in public settings object
  const { adminPasswordHash, ...safeSettings } = store.settings;
  return safeSettings;
}

function updateSettings(updates) {
  const store = loadStore();
  Object.assign(store.settings, updates);
  saveStore();
  return getSettings();
}

function verifyPassword(plainPassword) {
  const store = loadStore();
  if (!store.settings.adminPasswordHash) return false;
  return bcrypt.compareSync(plainPassword, store.settings.adminPasswordHash);
}

function setPassword(newPassword) {
  const store = loadStore();
  const salt = bcrypt.genSaltSync(10);
  store.settings.adminPasswordHash = bcrypt.hashSync(newPassword, salt);
  // Invalidate all active sessions
  store.settings.sessionVersion = (store.settings.sessionVersion || 1) + 1;
  saveStore();
}

function getSessionVersion() {
  const store = loadStore();
  return store.settings.sessionVersion || 1;
}

function invalidateAllSessions() {
  const store = loadStore();
  store.settings.sessionVersion = (store.settings.sessionVersion || 1) + 1;
  saveStore();
  return store.settings.sessionVersion;
}

// === Quick Send (Clips) ===
function getClips() {
  const store = loadStore();
  return store.clips || [];
}

function addClip({ text, type = 'text', device = 'Device' }) {
  const store = loadStore();
  if (!store.clips) store.clips = [];
  
  const clip = {
    id: crypto.randomBytes(6).toString('hex'),
    text: text.trim(),
    type,
    createdAt: new Date().toISOString(),
    device
  };

  // Add to top of list and limit to last 50 clips
  store.clips.unshift(clip);
  if (store.clips.length > 50) {
    store.clips = store.clips.slice(0, 50);
  }
  saveStore();
  return clip;
}

function deleteClip(id) {
  const store = loadStore();
  if (!store.clips) return false;
  const initialLen = store.clips.length;
  store.clips = store.clips.filter(c => c.id !== id);
  if (store.clips.length !== initialLen) {
    saveStore();
    return true;
  }
  return false;
}

function clearClips() {
  const store = loadStore();
  store.clips = [];
  saveStore();
  return true;
}

// === Shares ===
function listShares() {
  const store = loadStore();
  // Clean expired shares on read
  purgeExpiredShares();
  return Object.values(store.shares || {});
}

function getShare(id) {
  const store = loadStore();
  purgeExpiredShares();
  return store.shares ? store.shares[id] : null;
}

function createShare({ targetRelativePath, fileName, isDirectory, fileSize, expiryHours, password = '', downloadLimit = 0 }) {
  const store = loadStore();
  if (!store.shares) store.shares = {};

  const shareId = crypto.randomBytes(8).toString('hex');
  let expiryDate = null;
  if (expiryHours && expiryHours > 0) {
    expiryDate = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
  }

  let passwordHash = null;
  if (password && password.trim().length > 0) {
    passwordHash = bcrypt.hashSync(password.trim(), 8);
  }

  const share = {
    id: shareId,
    targetRelativePath,
    fileName,
    isDirectory,
    fileSize,
    expiryDate,
    hasPassword: Boolean(passwordHash),
    passwordHash,
    downloadLimit: downloadLimit > 0 ? downloadLimit : null,
    downloadCount: 0,
    createdAt: new Date().toISOString()
  };

  store.shares[shareId] = share;
  saveStore();
  return share;
}

function incrementShareDownload(id) {
  const store = loadStore();
  const share = store.shares[id];
  if (!share) return null;
  
  share.downloadCount = (share.downloadCount || 0) + 1;
  
  // Check if reached limit
  if (share.downloadLimit && share.downloadCount >= share.downloadLimit) {
    delete store.shares[id];
  }
  saveStore();
  return share;
}

function deleteShare(id) {
  const store = loadStore();
  if (store.shares && store.shares[id]) {
    delete store.shares[id];
    saveStore();
    return true;
  }
  return false;
}

function purgeExpiredShares() {
  const store = loadStore();
  if (!store.shares) return;
  const now = Date.now();
  let changed = false;

  for (const [id, share] of Object.entries(store.shares)) {
    if (share.expiryDate && new Date(share.expiryDate).getTime() < now) {
      delete store.shares[id];
      changed = true;
    }
  }

  if (changed) saveStore();
}

// === Trash ===
function getTrashItems() {
  const store = loadStore();
  return store.trash || [];
}

function addTrashItem({ id, originalPath, trashFileName, name, isDirectory, size }) {
  const store = loadStore();
  if (!store.trash) store.trash = [];

  const item = {
    id,
    originalPath,
    trashFileName,
    name,
    isDirectory,
    size,
    deletedAt: new Date().toISOString()
  };

  store.trash.unshift(item);
  saveStore();
  return item;
}

function getTrashItem(id) {
  const store = loadStore();
  return store.trash.find(item => item.id === id);
}

function removeTrashItem(id) {
  const store = loadStore();
  const idx = store.trash.findIndex(item => item.id === id);
  if (idx !== -1) {
    const [removed] = store.trash.splice(idx, 1);
    saveStore();
    return removed;
  }
  return null;
}

function clearTrashItems() {
  const store = loadStore();
  const items = [...(store.trash || [])];
  store.trash = [];
  saveStore();
  return items;
}

/**
 * Runs maintenance routines:
 * 1. Purges expired share links
 * 2. Purges trash older than retention days (default 30)
 * 3. Purges uploads older than autoDeleteDays if enabled
 */
function runMaintenance() {
  const store = loadStore();
  purgeExpiredShares();

  // Purge old trash
  const retentionDays = store.settings.trashRetentionDays || DEFAULT_RETENTION_DAYS;
  const maxTrashAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (store.trash && store.trash.length > 0) {
    const remainingTrash = [];
    for (const item of store.trash) {
      const age = now - new Date(item.deletedAt).getTime();
      if (age > maxTrashAgeMs) {
        // Permanently delete from disk
        const trashPath = path.join(TRASH_DIR, item.trashFileName);
        try {
          if (fs.existsSync(trashPath)) {
            fs.rmSync(trashPath, { recursive: true, force: true });
          }
        } catch (e) {
          console.error('Failed to purge trash item from disk:', item.trashFileName, e.message);
        }
      } else {
        remainingTrash.push(item);
      }
    }
    if (remainingTrash.length !== store.trash.length) {
      store.trash = remainingTrash;
      saveStore();
    }
  }

  // Purge old files if autoDeleteDays is set
  const autoDays = store.settings.autoDeleteDays;
  if (autoDays && autoDays > 0) {
    const maxAgeMs = autoDays * 24 * 60 * 60 * 1000;
    function purgeOldUploads(dir) {
      if (!fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && (now - stat.mtimeMs) > maxAgeMs) {
            fs.unlinkSync(fullPath);
          } else if (entry.isDirectory()) {
            purgeOldUploads(fullPath);
            // Remove empty dirs
            if (fs.readdirSync(fullPath).length === 0) {
              fs.rmdirSync(fullPath);
            }
          }
        }
      } catch (e) {
        // Ignore errors during auto-delete
      }
    }
    purgeOldUploads(UPLOADS_DIR);
  }
}

module.exports = {
  loadStore,
  initSettings,
  getSettings,
  updateSettings,
  verifyPassword,
  setPassword,
  getSessionVersion,
  invalidateAllSessions,
  getClips,
  addClip,
  deleteClip,
  clearClips,
  listShares,
  getShare,
  createShare,
  incrementShareDownload,
  deleteShare,
  getTrashItems,
  getTrashItem,
  addTrashItem,
  removeTrashItem,
  clearTrashItems,
  runMaintenance
};
