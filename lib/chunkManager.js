const fs = require('fs');
const path = require('path');
const { TEMP_CHUNKS_DIR, UPLOADS_DIR, resolveSafePath, sanitizeFilename, getAvailableFilename } = require('./storage');

// In-memory tracking of active chunk sessions
const activeSessions = new Map();

/**
 * Initializes a chunked upload session
 */
function initSession({ uploadId, fileName, fileSize, totalChunks, relativePath = '', conflictAction = 'rename' }) {
  const sessionDir = path.join(TEMP_CHUNKS_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const session = {
    uploadId,
    fileName: sanitizeFilename(fileName),
    fileSize: parseInt(fileSize, 10),
    totalChunks: parseInt(totalChunks, 10),
    relativePath,
    conflictAction, // 'rename' | 'replace' | 'skip'
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  // Write session meta to disk for resilience across restarts
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(session, null, 2), 'utf8');
  activeSessions.set(uploadId, session);
  return session;
}

/**
 * Gets the upload status of an ongoing session and lists already uploaded chunk indices
 */
function getSessionStatus(uploadId) {
  const sessionDir = path.join(TEMP_CHUNKS_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) {
    return null;
  }

  let session = activeSessions.get(uploadId);
  if (!session) {
    const metaPath = path.join(sessionDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        session = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        activeSessions.set(uploadId, session);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  const files = fs.readdirSync(sessionDir);
  const uploadedChunks = files
    .filter(f => f.startsWith('chunk_'))
    .map(f => parseInt(f.replace('chunk_', ''), 10))
    .sort((a, b) => a - b);

  return {
    uploadId,
    fileName: session.fileName,
    totalChunks: session.totalChunks,
    uploadedChunks,
    isComplete: uploadedChunks.length === session.totalChunks
  };
}

/**
 * Saves an uploaded chunk file
 */
function saveChunk(uploadId, chunkIndex, chunkBuffer) {
  const sessionDir = path.join(TEMP_CHUNKS_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const chunkPath = path.join(sessionDir, `chunk_${chunkIndex}`);
  fs.writeFileSync(chunkPath, chunkBuffer);

  const session = activeSessions.get(uploadId);
  if (session) {
    session.updatedAt = Date.now();
  }
}

/**
 * Assembles all chunks sequentially into the target destination file
 */
async function assembleChunks({ uploadId, targetFolder = '', conflictAction }) {
  const sessionDir = path.join(TEMP_CHUNKS_DIR, uploadId);
  if (!fs.existsSync(sessionDir)) {
    throw new Error('Upload session not found');
  }

  const metaPath = path.join(sessionDir, 'meta.json');
  let session = activeSessions.get(uploadId);
  if (!session && fs.existsSync(metaPath)) {
    session = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }

  if (!session) {
    throw new Error('Session metadata not found');
  }

  const finalAction = conflictAction || session.conflictAction || 'rename';

  // Determine target directory inside UPLOADS_DIR
  let destinationDir = UPLOADS_DIR;
  if (targetFolder) {
    destinationDir = resolveSafePath(UPLOADS_DIR, targetFolder);
  } else if (session.relativePath) {
    // If relative path has subdirectories (folder upload)
    const dirPart = path.dirname(session.relativePath);
    if (dirPart && dirPart !== '.') {
      destinationDir = resolveSafePath(UPLOADS_DIR, dirPart);
    }
  }

  if (!fs.existsSync(destinationDir)) {
    fs.mkdirSync(destinationDir, { recursive: true });
  }

  // Resolve final filename based on conflict action
  let finalFileName = session.fileName;
  const targetFilePath = path.join(destinationDir, finalFileName);

  if (fs.existsSync(targetFilePath)) {
    if (finalAction === 'skip') {
      // Clean up chunks without overwriting
      fs.rmSync(sessionDir, { recursive: true, force: true });
      activeSessions.delete(uploadId);
      return { skipped: true, fileName: finalFileName };
    } else if (finalAction === 'rename') {
      finalFileName = getAvailableFilename(destinationDir, session.fileName);
    } else if (finalAction === 'replace') {
      // Will overwrite targetFilePath
    }
  }

  const finalDestinationPath = path.join(destinationDir, finalFileName);
  const writeStream = fs.createWriteStream(finalDestinationPath, { flags: 'w' });

  for (let i = 0; i < session.totalChunks; i++) {
    const chunkPath = path.join(sessionDir, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      writeStream.close();
      throw new Error(`Missing chunk #${i}. Please retry.`);
    }

    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(chunkPath);
      readStream.on('error', reject);
      readStream.pipe(writeStream, { end: false });
      readStream.on('end', resolve);
    });
  }

  writeStream.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  // Verify file was written
  const stat = fs.statSync(finalDestinationPath);

  // Clean up chunk files and session
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Error cleaning session chunks dir:', e.message);
  }
  activeSessions.delete(uploadId);

  // Compute relative path from uploads dir for response
  const relativeToUploads = path.relative(UPLOADS_DIR, finalDestinationPath).replace(/\\/g, '/');

  return {
    success: true,
    fileName: finalFileName,
    relativePath: relativeToUploads,
    size: stat.size,
    actionTaken: finalAction
  };
}

/**
 * Periodically purge stale chunk folders older than 24 hours
 */
function cleanStaleSessions() {
  const maxAge = 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const entries = fs.readdirSync(TEMP_CHUNKS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(TEMP_CHUNKS_DIR, entry.name);
        const metaPath = path.join(dirPath, 'meta.json');
        let mtime = now;
        try {
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            mtime = meta.updatedAt || meta.createdAt || now;
          } else {
            mtime = fs.statSync(dirPath).mtimeMs;
          }
        } catch {
          mtime = fs.statSync(dirPath).mtimeMs;
        }

        if (now - mtime > maxAge) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          activeSessions.delete(entry.name);
        }
      }
    }
  } catch (err) {
    // Ignore error in cleanup
  }
}

module.exports = {
  initSession,
  getSessionStatus,
  saveChunk,
  assembleChunks,
  cleanStaleSessions
};
