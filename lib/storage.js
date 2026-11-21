const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const ROOT_DIR = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const TRASH_DIR = path.join(ROOT_DIR, 'trash');
const TEMP_CHUNKS_DIR = path.join(ROOT_DIR, 'temp_chunks');
const DATA_DIR = path.join(ROOT_DIR, 'data');

// Ensure required core directories exist
[UPLOADS_DIR, TRASH_DIR, TEMP_CHUNKS_DIR, DATA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Resolves user-provided relative path safely against a base directory.
 * Prevents directory traversal attacks (no "..", null bytes, etc.)
 */
function resolveSafePath(baseDir, userInputPath = '') {
  if (!userInputPath || typeof userInputPath !== 'string') {
    return baseDir;
  }

  // Reject null bytes or dangerous characters
  if (userInputPath.indexOf('\0') !== -1) {
    throw new Error('Invalid path: null byte detected');
  }

  // Clean leading and trailing slashes/backslashes
  const cleanRelative = userInputPath.replace(/^[\/\\]+/, '');
  const resolved = path.resolve(baseDir, cleanRelative);

  // Verify that the resolved absolute path starts strictly with baseDir
  const normalizedBase = path.normalize(baseDir);
  const normalizedResolved = path.normalize(resolved);

  if (
    normalizedResolved !== normalizedBase &&
    !normalizedResolved.startsWith(normalizedBase + path.sep)
  ) {
    throw new Error('Access denied: Path traversal detected');
  }

  return normalizedResolved;
}

/**
 * Sanitizes a single filename (not path)
 */
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed_file';
  // Strip control chars, directory separators, quotes, wildcards
  let clean = filename
    .replace(/[\/\?<>\\:\*\|":]/g, '_')
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .trim();

  // Prevent dot-dot or only dots
  if (/^\.+$/.test(clean) || clean.length === 0) {
    clean = 'file_' + Date.now();
  }

  // Limit length safely
  if (clean.length > 240) {
    const ext = path.extname(clean);
    const base = path.basename(clean, ext);
    clean = base.substring(0, 240 - ext.length) + ext;
  }

  return clean;
}

/**
 * Generates an available unique filename in a target folder:
 * "photo.jpg" -> "photo (1).jpg", "photo (2).jpg", etc.
 */
function getAvailableFilename(targetDir, desiredName) {
  const safeName = sanitizeFilename(desiredName);
  let finalPath = path.join(targetDir, safeName);

  if (!fs.existsSync(finalPath)) {
    return safeName;
  }

  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

  let counter = 1;
  while (fs.existsSync(finalPath)) {
    const candidate = `${base} (${counter})${ext}`;
    finalPath = path.join(targetDir, candidate);
    counter++;
  }

  return path.basename(finalPath);
}

/**
 * Categorizes a file by extension / mime
 */
function getFileTypeCategory(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  
  const images = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tiff', 'heic'];
  const videos = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'm4v', '3gp', 'ogv'];
  const audios = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus', 'mid'];
  const documents = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv', 'epub'];
  const codes = ['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py', 'c', 'cpp', 'h', 'cs', 'java', 'go', 'rs', 'php', 'rb', 'sh', 'sql', 'yaml', 'yml', 'xml', 'env'];
  const archives = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'];

  if (images.includes(ext)) return 'image';
  if (videos.includes(ext)) return 'video';
  if (audios.includes(ext)) return 'audio';
  if (documents.includes(ext)) return 'document';
  if (codes.includes(ext)) return 'code';
  if (archives.includes(ext)) return 'archive';
  return 'other';
}

/**
 * Formats bytes into human readable format (KB, MB, GB, etc.)
 */
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Recursively calculates folder size and item counts
 */
function getDirectoryStats(dirPath) {
  let totalBytes = 0;
  let fileCount = 0;
  let folderCount = 0;

  function traverse(currentPath) {
    if (!fs.existsSync(currentPath)) return;
    try {
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(currentPath, item.name);
        try {
          if (item.isDirectory()) {
            folderCount++;
            traverse(full);
          } else if (item.isFile()) {
            fileCount++;
            const stat = fs.statSync(full);
            totalBytes += stat.size;
          }
        } catch {
          // ignore individual item read errors
        }
      }
    } catch {
      // ignore
    }
  }

  traverse(dirPath);
  return { totalBytes, fileCount, folderCount };
}

/**
 * Returns overall storage information including disk free/total
 */
function getStorageInfo() {
  const uploadsStats = getDirectoryStats(UPLOADS_DIR);
  const trashStats = getDirectoryStats(TRASH_DIR);

  let diskTotal = 0;
  let diskFree = 0;

  try {
    const statfs = fs.statfsSync(UPLOADS_DIR);
    diskTotal = statfs.blocks * statfs.bsize;
    diskFree = statfs.bavail * statfs.bsize;
  } catch (err) {
    // Fallback if statfs fails
    diskTotal = 100 * 1024 * 1024 * 1024; // 100 GB default fallback
    diskFree = 50 * 1024 * 1024 * 1024;
  }

  return {
    uploadsBytes: uploadsStats.totalBytes,
    uploadsFiles: uploadsStats.fileCount,
    uploadsFolders: uploadsStats.folderCount,
    trashBytes: trashStats.totalBytes,
    trashFiles: trashStats.fileCount,
    diskTotal,
    diskFree,
    diskUsed: diskTotal - diskFree,
    formatted: {
      uploads: formatBytes(uploadsStats.totalBytes),
      trash: formatBytes(trashStats.totalBytes),
      diskTotal: formatBytes(diskTotal),
      diskFree: formatBytes(diskFree),
      diskUsed: formatBytes(diskTotal - diskFree),
    }
  };
}

/**
 * Checks if a filename has an executable or blocked extension
 */
function isBlockedExtension(filename, customBlockedList = []) {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return false;
  return customBlockedList.map(e => e.trim().toLowerCase()).includes(ext);
}

module.exports = {
  ROOT_DIR,
  UPLOADS_DIR,
  TRASH_DIR,
  TEMP_CHUNKS_DIR,
  DATA_DIR,
  resolveSafePath,
  sanitizeFilename,
  getAvailableFilename,
  getFileTypeCategory,
  formatBytes,
  getDirectoryStats,
  getStorageInfo,
  isBlockedExtension
};
