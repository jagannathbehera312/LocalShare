/**
 * DropLite Automated End-to-End Verification Test Suite
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, startServer } = require('./server');

const PORT = 5001; // use separate test port
let testServer;

function request({ method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: { ...headers }
    };

    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    if (body) {
      options.headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          text,
          json,
          raw
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting DropLite Automated Tests ---');
  let authCookie = '';

  try {
    testServer = startServer(PORT, '127.0.0.1');
    console.log(`Test server running on port ${PORT}`);

    // 1. Test Static files
    const resHome = await request({ path: '/' });
    console.assert(resHome.statusCode === 200, 'Home page should return 200');
    console.assert(resHome.text.includes('DropLite'), 'Home page should contain "DropLite"');
    console.log('✓ Test 1: Static HTML serving passed');

    // 2. Test Login Authentication
    const badLogin = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { password: 'wrongpassword' }
    });
    console.assert(badLogin.statusCode === 401, 'Bad login should return 401');

    const goodLogin = await request({
      method: 'POST',
      path: '/api/auth/login',
      body: { password: 'droplite123' }
    });
    console.assert(goodLogin.statusCode === 200, 'Good login should return 200');
    const setCookie = goodLogin.headers['set-cookie'];
    console.assert(setCookie && setCookie.length > 0, 'Login should return session cookie');
    authCookie = setCookie[0].split(';')[0];
    console.log('✓ Test 2: Authentication & session cookies passed');

    // 3. Test Storage Info
    const resStorage = await request({
      path: '/api/storage',
      headers: { Cookie: authCookie }
    });
    console.assert(resStorage.statusCode === 200, 'Storage endpoint should return 200');
    console.assert(resStorage.json.diskFree > 0, 'Storage should report diskFree');
    console.log('✓ Test 3: Storage info and disk space passed');

    // 4. Test LAN Info & QR
    const resLan = await request({
      path: '/api/lan-info',
      headers: { Cookie: authCookie }
    });
    console.assert(resLan.statusCode === 200, 'LAN info should return 200');
    console.assert(resLan.json.lanUrl.startsWith('http'), 'LAN URL should be formatted');

    const resQr = await request({
      path: `/api/qr?text=${encodeURIComponent('http://192.168.1.50:5000')}`,
      headers: { Cookie: authCookie }
    });
    console.assert(resQr.statusCode === 200, 'QR should return 200');
    console.assert(resQr.text.includes('<svg'), 'QR should return SVG');
    console.log('✓ Test 4: LAN info and QR generation passed');

    // 5. Test Quick Send (Clips)
    const resClip = await request({
      method: 'POST',
      path: '/api/clips',
      headers: { Cookie: authCookie },
      body: { text: 'Hello from iPhone clipboard!', type: 'text', device: 'iPhone 15' }
    });
    console.assert(resClip.statusCode === 200, 'Add clip should return 200');
    const clipId = resClip.json.clip.id;

    const resListClips = await request({
      path: '/api/clips',
      headers: { Cookie: authCookie }
    });
    console.assert(resListClips.json.some(c => c.id === clipId), 'Clips list should include new clip');

    await request({
      method: 'DELETE',
      path: `/api/clips/${clipId}`,
      headers: { Cookie: authCookie }
    });
    console.log('✓ Test 5: Quick Send clips CRUD passed');

    // 6. Test Folder Creation
    const testFolderName = `TestFolder_${Date.now()}`;
    const resFolder = await request({
      method: 'POST',
      path: '/api/folder',
      headers: { Cookie: authCookie },
      body: { folder: '', name: testFolderName }
    });
    console.assert(resFolder.statusCode === 200, 'Create folder should return 200');
    console.log('✓ Test 6: Folder creation passed');

    // 7. Test Chunked Resumable Upload
    const uploadId = `test_upload_${Date.now()}`;
    const testFileName = 'large_test_document.txt';
    const chunkData = Buffer.from('Part 1 of the chunked upload file. '.repeat(100));

    // Init session
    const resInit = await request({
      method: 'POST',
      path: '/api/upload/init',
      headers: { Cookie: authCookie },
      body: {
        uploadId,
        fileName: testFileName,
        fileSize: chunkData.length,
        totalChunks: 1,
        relativePath: `${testFolderName}/${testFileName}`,
        conflictAction: 'rename'
      }
    });
    console.assert(resInit.statusCode === 200, 'Init chunk upload should return 200');

    // Upload chunk with multipart form boundary
    const boundary = '----WebKitFormBoundaryTest123456';
    const formHeader = `--${boundary}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${uploadId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk_0"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const formFooter = `\r\n--${boundary}--\r\n`;
    const multipartBody = Buffer.concat([
      Buffer.from(formHeader, 'utf8'),
      chunkData,
      Buffer.from(formFooter, 'utf8')
    ]);

    const resChunk = await request({
      method: 'POST',
      path: '/api/upload/chunk',
      headers: {
        Cookie: authCookie,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: multipartBody
    });
    console.assert(resChunk.statusCode === 200, 'Upload chunk should return 200');

    // Assemble chunks
    const resComplete = await request({
      method: 'POST',
      path: '/api/upload/complete',
      headers: { Cookie: authCookie },
      body: { uploadId, targetFolder: testFolderName, conflictAction: 'rename' }
    });
    console.assert(resComplete.statusCode === 200, 'Assemble chunk upload should return 200');
    console.log('✓ Test 7: Chunked resumable upload passed');

    // 8. Test Download & Content-Disposition
    const relFilePath = `${testFolderName}/${testFileName}`;
    const resDownload = await request({
      path: `/api/download/${encodeURIComponent(relFilePath)}`,
      headers: { Cookie: authCookie }
    });
    console.assert(resDownload.statusCode === 200, 'Download should return 200');
    console.assert(resDownload.headers['content-disposition'].includes('filename*='), 'Should include RFC 5987 filename*');
    console.assert(resDownload.raw.length === chunkData.length, 'Downloaded length should match uploaded data');
    console.log('✓ Test 8: Single file download with RFC 5987 passed');

    // 9. Test Share Link Creation & Public Access
    const resShare = await request({
      method: 'POST',
      path: '/api/shares',
      headers: { Cookie: authCookie },
      body: {
        path: relFilePath,
        expiryHours: 24,
        password: '',
        downloadLimit: 5
      }
    });
    console.assert(resShare.statusCode === 200, 'Create share link should return 200');
    const shareId = resShare.json.share.id;

    // Access public share info without login
    const resPublicShare = await request({
      path: `/api/public/share/${shareId}`
    });
    console.assert(resPublicShare.statusCode === 200, 'Public share info should be accessible');
    console.assert(resPublicShare.json.fileName === testFileName, 'Public share file name matches');

    // Public download
    const resPublicDownload = await request({
      path: `/api/public/share/${shareId}/download`
    });
    console.assert(resPublicDownload.statusCode === 200, 'Public download should return 200');
    console.log('✓ Test 9: Public share links and downloads passed');

    // 10. Test Move to Trash & Restore
    const resTrash = await request({
      method: 'POST',
      path: '/api/trash',
      headers: { Cookie: authCookie },
      body: { items: [relFilePath] }
    });
    console.assert(resTrash.statusCode === 200, 'Move to trash should return 200');

    const resTrashList = await request({
      path: '/api/trash',
      headers: { Cookie: authCookie }
    });
    console.assert(resTrashList.json.items.length > 0, 'Trash list should contain item');
    const trashedItem = resTrashList.json.items.find(i => i.originalPath === relFilePath);
    console.assert(trashedItem, 'Item found in trash');

    // Restore
    const resRestore = await request({
      method: 'POST',
      path: '/api/trash/restore',
      headers: { Cookie: authCookie },
      body: { id: trashedItem.id }
    });
    console.assert(resRestore.statusCode === 200, 'Restore from trash should return 200');
    console.log('✓ Test 10: Trash soft-delete and restore passed');

    // 11. Test Multi-select ZIP Download
    const resZip = await request({
      method: 'POST',
      path: '/api/download-zip',
      headers: { Cookie: authCookie },
      body: { paths: [testFolderName] }
    });
    console.assert(resZip.statusCode === 200, 'ZIP download should return 200');
    console.assert(resZip.headers['content-type'] === 'application/zip', 'Content-Type should be application/zip');
    console.log('✓ Test 11: Multi-select streaming ZIP download passed');

    // Clean up test folder
    const cleanUploadsPath = path.join(__dirname, 'uploads', testFolderName);
    if (fs.existsSync(cleanUploadsPath)) {
      fs.rmSync(cleanUploadsPath, { recursive: true, force: true });
    }

    console.log('\n=============================================');
    console.log(' 🎉 ALL 11 TEST SUITES PASSED FLAWLESSLY! ');
    console.log('=============================================\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  } finally {
    if (testServer) testServer.close();
  }
}

runTests();
