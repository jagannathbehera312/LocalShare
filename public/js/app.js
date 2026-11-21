/**
 * DropLite - Personal Cloud & Fast File Transfer
 * Main Frontend Application Script (Vanilla JS, Zero Dependencies)
 */

(function () {
  'use strict';

  // ==========================================
  // Application State
  // ==========================================
  const state = {
    authenticated: false,
    currentFolder: '', // relative path from uploads root
    items: [], // current folder file/folder list
    selectedItems: new Set(), // set of relativePath strings
    activeView: 'files', // 'files' | 'quicksend' | 'shares' | 'trash' | 'settings'
    filterType: 'all',
    searchQuery: '',
    sortBy: 'name_asc',
    viewMode: localStorage.getItem('droplite_view_mode') || 'grid',
    theme: localStorage.getItem('droplite_theme') || 'system',
    settings: {},
    storage: {},
    lanInfo: null,
    // Lightbox state
    lightboxItems: [],
    lightboxIndex: -1,
    // Active uploads tracking
    uploadQueue: [],
    isUploading: false
  };

  // ==========================================
  // DOM Elements Selector Helper
  // ==========================================
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ==========================================
  // Initialization & Service Worker
  // ==========================================
  async function init() {
    applyTheme(state.theme);
    setupServiceWorker();
    setupEventListeners();
    setupClipboardPaste();
    setupTouchSwipe();
    
    // Check authentication
    const authed = await checkAuth();
    if (authed) {
      onAuthenticated();
    } else {
      openModal('modal-login');
    }

    // Check if launched from Android Web Share Target
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('shared') === '1') {
      showToast('Files received via Android Share!', 'success');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service Worker registration skipped:', err);
      });
    }
  }

  // ==========================================
  // Authentication & Session
  // ==========================================
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/check');
      const data = await res.json();
      state.authenticated = Boolean(data.authenticated);
      return state.authenticated;
    } catch {
      return false;
    }
  }

  function onAuthenticated() {
    closeModal('modal-login');
    connectSSE();
    loadLANInfo();
    loadSettings();
    loadStorageStats();
    loadFolder(state.currentFolder);
    loadClips();
  }

  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('login-password').value.trim();
    const errorEl = $('login-error');
    errorEl.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();

      if (res.ok) {
        state.authenticated = true;
        onAuthenticated();
        showToast('Welcome to DropLite!', 'success');
      } else {
        errorEl.textContent = data.error || 'Incorrect password';
        errorEl.style.display = 'block';
      }
    } catch (err) {
      errorEl.textContent = 'Server connection error';
      errorEl.style.display = 'block';
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    if (confirm('Sign out of DropLite on this device?')) {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.reload();
    }
  });

  $('btn-logout-all').addEventListener('click', async () => {
    if (confirm('Log out all devices and sessions? Everyone will need to enter the master password again.')) {
      await fetch('/api/auth/logout-all', { method: 'POST' });
      showToast('All devices logged out', 'info');
      setTimeout(() => window.location.reload(), 800);
    }
  });

  // ==========================================
  // Live Sync (SSE - Server Sent Events)
  // ==========================================
  let eventSource = null;

  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/events');

    eventSource.addEventListener('file_change', () => {
      loadFolder(state.currentFolder, true);
      loadStorageStats();
    });

    eventSource.addEventListener('folder_change', () => {
      loadFolder(state.currentFolder, true);
      loadStorageStats();
    });

    eventSource.addEventListener('trash_change', () => {
      if (state.activeView === 'trash') loadTrash();
      loadStorageStats();
    });

    eventSource.addEventListener('clip_new', (e) => {
      loadClips();
      if (state.activeView !== 'quicksend') {
        showToast('⚡ New note received in Quick Send!', 'info');
      }
    });

    eventSource.addEventListener('clip_delete', () => {
      loadClips();
    });

    eventSource.addEventListener('clip_clear', () => {
      loadClips();
    });

    eventSource.addEventListener('settings_change', (e) => {
      loadSettings();
    });

    eventSource.onerror = () => {
      // Automatic reconnect built into EventSource
    };
  }

  // ==========================================
  // Storage Stats & LAN Info
  // ==========================================
  async function loadStorageStats() {
    try {
      const res = await fetch('/api/storage');
      if (!res.ok) return;
      const data = await res.json();
      state.storage = data;

      // Update Sidebar Storage Widget
      const usedBytes = data.uploadsBytes || 0;
      const totalBytes = data.quotaBytes > 0 ? data.quotaBytes : data.diskTotal;
      const percent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;

      $('sidebar-storage-percent').textContent = `${percent}%`;
      $('sidebar-storage-bar').style.width = `${percent}%`;
      $('sidebar-storage-used').textContent = data.formatted.uploads;
      $('sidebar-storage-free').textContent = `Free: ${data.formatted.diskFree}`;

      // Badge counts
      $('nav-files-count').textContent = data.uploadsFiles || 0;
      $('nav-trash-count').textContent = data.trashFiles || 0;
    } catch (err) {
      console.warn('Storage stat load error:', err);
    }
  }

  async function loadLANInfo() {
    try {
      const res = await fetch('/api/lan-info');
      if (!res.ok) return;
      state.lanInfo = await res.json();
      $('lan-url-text').textContent = state.lanInfo.lanUrl;
      const qrUrl = `/api/qr?text=${encodeURIComponent(state.lanInfo.lanUrl)}`;
      $('lan-qr-container').innerHTML = `<img src="${qrUrl}" style="width:100%; height:100%; object-fit:contain;" alt="LAN QR Code">`;
    } catch {
      // ignore
    }
  }

  // ==========================================
  // File Listing & Navigation
  // ==========================================
  async function loadFolder(folderPath = '', silent = false) {
    state.currentFolder = folderPath;
    if (!silent) {
      state.selectedItems.clear();
      updateMultiselectBar();
    }

    renderBreadcrumbs(folderPath);

    try {
      const res = await fetch(`/api/files?folder=${encodeURIComponent(folderPath)}`);
      if (res.status === 401) {
        openModal('modal-login');
        return;
      }
      const data = await res.json();
      state.items = data.items || [];
      renderFiles();
    } catch (err) {
      showToast('Error loading folder', 'error');
    }
  }

  function renderBreadcrumbs(folderPath) {
    const container = $('breadcrumbs');
    container.innerHTML = '';

    const rootItem = document.createElement('div');
    rootItem.className = `breadcrumb-item ${folderPath === '' ? 'active' : ''}`;
    rootItem.textContent = 'Home';
    rootItem.onclick = () => loadFolder('');
    container.appendChild(rootItem);

    if (folderPath) {
      const parts = folderPath.split('/').filter(Boolean);
      let accumulated = '';
      parts.forEach((part, index) => {
        accumulated += (accumulated ? '/' : '') + part;
        const currentPath = accumulated;
        const isLast = index === parts.length - 1;

        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator';
        sep.textContent = '/';
        container.appendChild(sep);

        const item = document.createElement('div');
        item.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
        item.textContent = part;
        item.onclick = () => loadFolder(currentPath);
        container.appendChild(item);
      });
    }
  }

  function filterAndSortItems(items) {
    let result = [...items];

    // Filter by search query
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase();
      result = result.filter(item => item.name.toLowerCase().includes(q));
    }

    // Filter by category
    if (state.filterType !== 'all') {
      result = result.filter(item => item.isDirectory || item.category === state.filterType);
    }

    // Sort items (folders always stay at top)
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      switch (state.sortBy) {
        case 'name_desc':
          return b.name.localeCompare(a.name);
        case 'date_desc':
          return new Date(b.mtime) - new Date(a.mtime);
        case 'date_asc':
          return new Date(a.mtime) - new Date(b.mtime);
        case 'size_desc':
          return (b.size || 0) - (a.size || 0);
        case 'size_asc':
          return (a.size || 0) - (b.size || 0);
        case 'name_asc':
        default:
          return a.name.localeCompare(b.name);
      }
    });

    return result;
  }

  function renderFiles() {
    const items = filterAndSortItems(state.items);
    const gridEl = $('files-grid');
    const tbodyEl = $('files-list-tbody');
    const emptyEl = $('files-empty');
    const tableEl = $('files-list');

    if (items.length === 0) {
      gridEl.style.display = 'none';
      tableEl.style.display = 'none';
      emptyEl.style.display = 'flex';
      return;
    }

    emptyEl.style.display = 'none';

    if (state.viewMode === 'grid') {
      gridEl.style.display = 'grid';
      tableEl.style.display = 'none';
      renderGrid(items, gridEl);
    } else {
      gridEl.style.display = 'none';
      tableEl.style.display = 'table';
      renderList(items, tbodyEl);
    }
  }

  function getCategoryColor(category) {
    const map = {
      folder: '#f59e0b',
      image: '#8b5cf6',
      video: '#ef4444',
      audio: '#10b981',
      document: '#3b82f6',
      archive: '#f97316',
      code: '#06b6d4',
      other: '#64748b'
    };
    return map[category] || '#64748b';
  }

  function getCategoryIcon(category) {
    switch (category) {
      case 'folder':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
      case 'image':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
      case 'video':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>';
      case 'audio':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
      case 'document':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';
      case 'code':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
      case 'archive':
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>';
      default:
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
    }
  }

  function renderGrid(items, container) {
    container.innerHTML = '';

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = `file-card ${state.selectedItems.has(item.relativePath) ? 'selected' : ''}`;
      card.dataset.path = item.relativePath;

      // Preview area
      const previewDiv = document.createElement('div');
      previewDiv.className = 'file-card-preview';

      if (item.category === 'image') {
        const img = document.createElement('img');
        img.src = `/api/preview/${encodeURIComponent(item.relativePath)}`;
        img.loading = 'lazy';
        img.alt = item.name;
        previewDiv.appendChild(img);
      } else {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'file-type-icon';
        iconDiv.style.backgroundColor = getCategoryColor(item.category);
        iconDiv.innerHTML = getCategoryIcon(item.category);
        previewDiv.appendChild(iconDiv);
      }

      // Checkbox
      const checkDiv = document.createElement('div');
      checkDiv.className = 'file-card-checkbox';
      checkDiv.innerHTML = state.selectedItems.has(item.relativePath)
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>'
        : '';
      checkDiv.onclick = (e) => {
        e.stopPropagation();
        toggleSelectItem(item.relativePath);
      };

      // Info area
      const infoDiv = document.createElement('div');
      infoDiv.className = 'file-card-info';
      infoDiv.innerHTML = `
        <div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="file-meta">
          <span>${item.isDirectory ? 'Folder' : (item.formattedSize || '0 B')}</span>
          <span>${formatDate(item.mtime)}</span>
        </div>
      `;

      card.appendChild(previewDiv);
      card.appendChild(checkDiv);
      card.appendChild(infoDiv);

      // Click behavior
      card.onclick = (e) => {
        if (state.selectedItems.size > 0) {
          toggleSelectItem(item.relativePath);
        } else if (item.isDirectory) {
          loadFolder(item.relativePath);
        } else {
          openLightbox(item);
        }
      };

      // Context menu or long press
      card.oncontextmenu = (e) => {
        e.preventDefault();
        toggleSelectItem(item.relativePath);
      };

      container.appendChild(card);
    });
  }

  function renderList(items, tbody) {
    tbody.innerHTML = '';

    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.className = state.selectedItems.has(item.relativePath) ? 'selected' : '';
      tr.dataset.path = item.relativePath;

      tr.innerHTML = `
        <td onclick="event.stopPropagation()">
          <input type="checkbox" ${state.selectedItems.has(item.relativePath) ? 'checked' : ''} aria-label="Select file">
        </td>
        <td>
          <div class="list-file-name-cell">
            <div class="list-file-icon" style="background-color: ${getCategoryColor(item.category)}">
              ${getCategoryIcon(item.category)}
            </div>
            <span class="file-name" style="max-width: 320px;">${escapeHtml(item.name)}</span>
          </div>
        </td>
        <td>${item.isDirectory ? '—' : item.formattedSize}</td>
        <td>${formatDate(item.mtime)}</td>
        <td style="text-align: right;" onclick="event.stopPropagation()">
          <button class="btn-icon btn-item-actions" title="Actions" style="width:30px; height:30px; display:inline-flex;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
          </button>
        </td>
      `;

      const checkbox = tr.querySelector('input[type="checkbox"]');
      checkbox.onchange = () => toggleSelectItem(item.relativePath);

      const actionBtn = tr.querySelector('.btn-item-actions');
      actionBtn.onclick = (e) => {
        e.stopPropagation();
        showItemMenu(item, e);
      };

      tr.onclick = () => {
        if (state.selectedItems.size > 0) {
          toggleSelectItem(item.relativePath);
        } else if (item.isDirectory) {
          loadFolder(item.relativePath);
        } else {
          openLightbox(item);
        }
      };

      tbody.appendChild(tr);
    });
  }

  // ==========================================
  // Multi-Selection Logic
  // ==========================================
  function toggleSelectItem(relPath) {
    if (state.selectedItems.has(relPath)) {
      state.selectedItems.delete(relPath);
    } else {
      state.selectedItems.add(relPath);
    }
    updateMultiselectBar();
    renderFiles();
  }

  function updateMultiselectBar() {
    const bar = $('multiselect-bar');
    const countEl = $('multiselect-count');
    const size = state.selectedItems.size;

    if (size > 0) {
      bar.classList.add('active');
      countEl.textContent = `${size} item${size > 1 ? 's' : ''} selected`;
      document.body.classList.add('multiselect-active');
    } else {
      bar.classList.remove('active');
      document.body.classList.remove('multiselect-active');
    }
  }

  $('btn-multi-clear').onclick = () => {
    state.selectedItems.clear();
    updateMultiselectBar();
    renderFiles();
  };

  $('th-select-all').onchange = (e) => {
    if (e.target.checked) {
      state.items.forEach(item => state.selectedItems.add(item.relativePath));
    } else {
      state.selectedItems.clear();
    }
    updateMultiselectBar();
    renderFiles();
  };

  $('btn-multi-download').onclick = () => {
    if (state.selectedItems.size === 0) return;
    downloadAsZip(Array.from(state.selectedItems));
  };

  $('btn-multi-trash').onclick = async () => {
    const count = state.selectedItems.size;
    if (count === 0) return;
    if (confirm(`Move ${count} item${count > 1 ? 's' : ''} to Trash?`)) {
      await moveItemsToTrash(Array.from(state.selectedItems));
      state.selectedItems.clear();
      updateMultiselectBar();
    }
  };

  $('btn-multi-move').onclick = () => {
    if (state.selectedItems.size === 0) return;
    openMoveModal(Array.from(state.selectedItems));
  };

  // ==========================================
  // Item Operations (Download, Move, Trash, Rename)
  // ==========================================
  async function downloadAsZip(paths) {
    showToast('Preparing ZIP archive...', 'info');
    try {
      const res = await fetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });

      if (!res.ok) throw new Error('Failed to generate ZIP');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `droplite-download-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('Download started', 'success');
    } catch (err) {
      showToast('ZIP download failed', 'error');
    }
  }

  async function moveItemsToTrash(paths) {
    try {
      const res = await fetch('/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: paths })
      });
      if (res.ok) {
        showToast('Moved to Trash', 'success');
        loadFolder(state.currentFolder);
      } else {
        showToast('Error moving to trash', 'error');
      }
    } catch {
      showToast('Error connecting to server', 'error');
    }
  }

  function showItemMenu(item, event) {
    const actions = [
      {
        label: 'Download',
        action: () => {
          if (item.isDirectory) {
            downloadAsZip([item.relativePath]);
          } else {
            window.location.href = `/api/download/${encodeURIComponent(item.relativePath)}`;
          }
        }
      },
      {
        label: 'Share Link',
        action: () => openShareModal(item)
      },
      {
        label: 'Rename',
        action: () => openRenameModal(item)
      },
      {
        label: 'Move',
        action: () => openMoveModal([item.relativePath])
      },
      {
        label: 'Move to Trash',
        danger: true,
        action: () => {
          if (confirm(`Move "${item.name}" to Trash?`)) {
            moveItemsToTrash([item.relativePath]);
          }
        }
      }
    ];

    // Simple context dropdown
    const menu = document.createElement('div');
    menu.style.position = 'fixed';
    menu.style.top = `${event.clientY}px`;
    menu.style.left = `${Math.min(window.innerWidth - 180, event.clientX)}px`;
    menu.style.background = 'var(--surface)';
    menu.style.border = '1px solid var(--border)';
    menu.style.borderRadius = 'var(--radius-md)';
    menu.style.boxShadow = 'var(--shadow-xl)';
    menu.style.zIndex = '500';
    menu.style.padding = '6px';
    menu.style.minWidth = '160px';

    actions.forEach((act) => {
      const btn = document.createElement('button');
      btn.style.width = '100%';
      btn.style.textAlign = 'left';
      btn.style.padding = '8px 12px';
      btn.style.borderRadius = 'var(--radius-xs)';
      btn.style.fontSize = '0.85rem';
      btn.style.justifyContent = 'flex-start';
      if (act.danger) btn.style.color = 'var(--color-danger)';
      btn.textContent = act.label;
      btn.onmouseenter = () => btn.style.backgroundColor = 'var(--bg-secondary)';
      btn.onmouseleave = () => btn.style.backgroundColor = 'transparent';
      btn.onclick = () => {
        document.body.removeChild(menu);
        act.action();
      };
      menu.appendChild(btn);
    });

    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        if (menu.parentElement) document.body.removeChild(menu);
        window.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => window.addEventListener('click', closeHandler), 10);
    document.body.appendChild(menu);
  }

  // ==========================================
  // Resumable & Chunked Upload Engine
  // ==========================================
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per chunk

  async function handleFilesSelected(files, targetFolder = state.currentFolder) {
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const uploadItem = {
        id: 'up_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        file,
        fileName: file.name,
        fileSize: file.size,
        targetFolder,
        relativePath: file.webkitRelativePath || file.name,
        progress: 0,
        speedStr: '0 KB/s',
        status: 'queued', // 'uploading' | 'paused' | 'done' | 'error'
        aborted: false
      };
      state.uploadQueue.push(uploadItem);
    }

    renderUploadManager();
    processUploadQueue();
  }

  async function processUploadQueue() {
    if (state.isUploading) return;
    const nextItem = state.uploadQueue.find(i => i.status === 'queued');
    if (!nextItem) return;

    state.isUploading = true;
    nextItem.status = 'uploading';
    renderUploadManager();

    try {
      await uploadFileInChunks(nextItem);
      nextItem.status = 'done';
      nextItem.progress = 100;
      showToast(`Uploaded "${nextItem.fileName}"`, 'success');
      loadFolder(state.currentFolder);
    } catch (err) {
      if (!nextItem.aborted) {
        nextItem.status = 'error';
        showToast(`Failed to upload "${nextItem.fileName}": ${err.message}`, 'error');
      }
    } finally {
      state.isUploading = false;
      renderUploadManager();
      processUploadQueue();
    }
  }

  async function uploadFileInChunks(item) {
    const file = item.file;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    const uploadId = 'chk_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

    // 1. Initialize Session
    const initRes = await fetch('/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        fileName: item.fileName,
        fileSize: file.size,
        totalChunks,
        relativePath: item.relativePath,
        conflictAction: 'rename'
      })
    });

    if (!initRes.ok) {
      const data = await initRes.json();
      throw new Error(data.error || 'Upload initialization rejected');
    }

    // 2. Upload Chunks
    let uploadedBytes = 0;
    const startTime = Date.now();

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (item.aborted) {
        throw new Error('Upload cancelled');
      }

      const start = chunkIdx * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunkBlob = file.slice(start, end);

      const formData = new FormData();
      formData.append('uploadId', uploadId);
      formData.append('chunkIndex', chunkIdx.toString());
      formData.append('chunk', chunkBlob);

      const chunkRes = await fetch('/api/upload/chunk', {
        method: 'POST',
        body: formData
      });

      if (!chunkRes.ok) {
        throw new Error(`Chunk ${chunkIdx} failed`);
      }

      uploadedBytes += (end - start);
      item.progress = Math.round((uploadedBytes / file.size) * 100);

      // Speed calculation
      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec > 0.5) {
        const bytesPerSec = uploadedBytes / elapsedSec;
        item.speedStr = formatSpeed(bytesPerSec);
      }

      updateUploadItemUI(item);
    }

    // 3. Complete & Assemble
    const compRes = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        targetFolder: item.targetFolder,
        conflictAction: 'rename'
      })
    });

    if (!compRes.ok) {
      const data = await compRes.json();
      throw new Error(data.error || 'Failed to assemble uploaded file');
    }

    return await compRes.json();
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec > 1024 * 1024) {
      return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    }
    return Math.round(bytesPerSec / 1024) + ' KB/s';
  }

  function renderUploadManager() {
    const manager = $('upload-manager');
    const list = $('upload-manager-list');
    const title = $('upload-manager-title');

    const activeList = state.uploadQueue.filter(i => i.status !== 'done');
    if (activeList.length === 0 && state.uploadQueue.length === 0) {
      manager.classList.remove('active');
      return;
    }

    manager.classList.add('active');
    const uploadingCount = state.uploadQueue.filter(i => i.status === 'uploading' || i.status === 'queued').length;
    title.textContent = uploadingCount > 0 ? `Uploading ${uploadingCount} file${uploadingCount > 1 ? 's' : ''}...` : 'Uploads completed';

    list.innerHTML = '';
    state.uploadQueue.slice(-5).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'upload-item-card';
      card.id = `up-card-${item.id}`;
      card.innerHTML = `
        <div class="upload-item-info">
          <span class="upload-item-name">${escapeHtml(item.fileName)}</span>
          <span class="upload-item-speed" id="up-speed-${item.id}">${item.status === 'done' ? '✓ Complete' : item.speedStr}</span>
        </div>
        <div class="upload-progress-bar">
          <div class="upload-progress-fill" id="up-fill-${item.id}" style="width: ${item.progress}%"></div>
        </div>
      `;
      list.appendChild(card);
    });
  }

  function updateUploadItemUI(item) {
    const fill = $(`up-fill-${item.id}`);
    const speed = $(`up-speed-${item.id}`);
    if (fill) fill.style.width = `${item.progress}%`;
    if (speed) speed.textContent = `${item.progress}% (${item.speedStr})`;
  }

  $('btn-close-upload-manager').onclick = () => {
    $('upload-manager').classList.remove('active');
  };

  // ==========================================
  // Drag and Drop & Native File Inputs
  // ==========================================
  const overlay = $('dropzone-overlay');
  let dragCounter = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.add('active');
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.remove('active');
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');

    if (e.dataTransfer && e.dataTransfer.items) {
      const files = [];
      const items = e.dataTransfer.items;

      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
        if (entry) {
          await traverseFileTree(entry, '', files);
        } else {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }

      handleFilesSelected(files);
    } else if (e.dataTransfer && e.dataTransfer.files) {
      handleFilesSelected(e.dataTransfer.files);
    }
  });

  async function traverseFileTree(item, currentPath, filesArray) {
    if (item.isFile) {
      const file = await new Promise((resolve) => item.file(resolve));
      // Store relative path for folder preservation
      file.customRelativePath = currentPath + file.name;
      filesArray.push(file);
    } else if (item.isDirectory) {
      const dirReader = item.createReader();
      const entries = await new Promise((resolve) => dirReader.readEntries(resolve));
      for (const child of entries) {
        await traverseFileTree(child, currentPath + item.name + '/', filesArray);
      }
    }
  }

  // Native Inputs
  $('btn-upload-picker').onclick = () => $('input-file').click();
  $('input-file').onchange = (e) => handleFilesSelected(e.target.files);

  $('fab-upload-files').onclick = () => {
    closeFabMenu();
    $('input-file').click();
  };

  $('fab-upload-folder').onclick = () => {
    closeFabMenu();
    $('input-folder').click();
  };
  $('input-folder').onchange = (e) => handleFilesSelected(e.target.files);

  $('fab-camera').onclick = () => {
    closeFabMenu();
    $('input-camera').click();
  };
  $('input-camera').onchange = (e) => handleFilesSelected(e.target.files);

  // Clipboard Paste (Ctrl+V)
  function setupClipboardPaste() {
    window.addEventListener('paste', async (e) => {
      // Don't intercept if focused on text input / textarea
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        return;
      }

      const clipboard = e.clipboardData;
      if (!clipboard) return;

      // 1. If files or images copied in clipboard
      if (clipboard.files && clipboard.files.length > 0) {
        showToast('Uploading file from clipboard...', 'info');
        handleFilesSelected(clipboard.files);
        return;
      }

      // 2. If text was copied
      const text = clipboard.getData('text');
      if (text && text.trim().length > 0) {
        if (confirm(`Send copied text to Quick Send?\n\n"${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`)) {
          await addQuickSendClip(text);
          switchView('quicksend');
        }
      }
    });
  }

  // ==========================================
  // Quick Send (Clips) Engine
  // ==========================================
  async function loadClips() {
    try {
      const res = await fetch('/api/clips');
      if (!res.ok) return;
      const clips = await res.json();
      $('nav-clips-count').textContent = clips.length;
      renderClips(clips);
    } catch {
      // ignore
    }
  }

  function renderClips(clips) {
    const feed = $('clips-feed');
    const empty = $('clips-empty');

    if (!clips || clips.length === 0) {
      feed.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    feed.innerHTML = '';

    clips.forEach((clip) => {
      const card = document.createElement('div');
      card.className = 'clip-card';
      const isUrl = /^https?:\/\//i.test(clip.text);

      card.innerHTML = `
        <div class="clip-header">
          <span>${clip.device || 'Web Browser'}</span>
          <span>${formatDate(clip.createdAt)}</span>
        </div>
        <div class="clip-content">${escapeHtml(clip.text)}</div>
        <div class="clip-footer">
          <button class="btn-copy-clip" id="btn-copy-${clip.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>Copy</span>
          </button>
          ${isUrl ? `<a href="${escapeHtml(clip.text)}" target="_blank" rel="noopener noreferrer" class="btn-copy-clip" style="text-decoration:none;">Open Link ↗</a>` : ''}
          <button class="btn-copy-clip" style="margin-left:auto; color:var(--text-tertiary);" id="btn-del-${clip.id}">Delete</button>
        </div>
      `;

      card.querySelector(`#btn-copy-${clip.id}`).onclick = () => {
        navigator.clipboard.writeText(clip.text).then(() => {
          showToast('Copied to clipboard!', 'success');
        });
      };

      card.querySelector(`#btn-del-${clip.id}`).onclick = async () => {
        await fetch(`/api/clips/${clip.id}`, { method: 'DELETE' });
        loadClips();
      };

      feed.appendChild(card);
    });
  }

  async function addQuickSendClip(text) {
    if (!text || !text.trim()) return;
    try {
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          type: /^https?:\/\//i.test(text) ? 'link' : 'text',
          device: getDeviceName()
        })
      });
      if (res.ok) {
        $('quicksend-input').value = '';
        showToast('Note shared across devices!', 'success');
        loadClips();
      }
    } catch {
      showToast('Failed to save clip', 'error');
    }
  }

  $('btn-quicksend-send').onclick = () => {
    addQuickSendClip($('quicksend-input').value);
  };

  $('quicksend-input').onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      addQuickSendClip($('quicksend-input').value);
    }
  };

  $('btn-quicksend-paste').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('quicksend-input').value = text;
      showToast('Pasted from clipboard', 'info');
    } catch {
      showToast('Clipboard access denied', 'error');
    }
  };

  $('btn-clear-clips').onclick = async () => {
    if (confirm('Clear all shared clips?')) {
      await fetch('/api/clips/clear', { method: 'POST' });
      loadClips();
    }
  };

  // ==========================================
  // Trash View & Purge
  // ==========================================
  async function loadTrash() {
    try {
      const res = await fetch('/api/trash');
      const data = await res.json();
      renderTrash(data.items || []);
    } catch {
      showToast('Failed to load trash', 'error');
    }
  }

  function renderTrash(items) {
    const list = $('trash-list');
    const empty = $('trash-empty');

    if (!items || items.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      row.innerHTML = `
        <div>
          <div class="settings-label">${escapeHtml(item.name)}</div>
          <div class="settings-sublabel">Original location: ${escapeHtml(item.originalPath)} • Deleted: ${formatDate(item.deletedAt)}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary" id="btn-restore-${item.id}" style="font-size:0.8rem; padding:4px 10px;">Restore</button>
          <button class="btn-secondary" id="btn-perm-del-${item.id}" style="font-size:0.8rem; padding:4px 10px; color:var(--color-danger);">Delete Forever</button>
        </div>
      `;

      row.querySelector(`#btn-restore-${item.id}`).onclick = async () => {
        const res = await fetch('/api/trash/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id })
        });
        if (res.ok) {
          showToast(`Restored "${item.name}"`, 'success');
          loadTrash();
        }
      };

      row.querySelector(`#btn-perm-del-${item.id}`).onclick = async () => {
        if (confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) {
          await fetch(`/api/trash/${item.id}`, { method: 'DELETE' });
          showToast('Permanently deleted', 'info');
          loadTrash();
        }
      };

      list.appendChild(row);
    });
  }

  $('btn-empty-trash').onclick = async () => {
    if (confirm('Permanently delete everything in the Trash? This cannot be undone.')) {
      const res = await fetch('/api/trash/empty', { method: 'POST' });
      if (res.ok) {
        showToast('Trash emptied', 'success');
        loadTrash();
      }
    }
  };

  // ==========================================
  // Share Links
  // ==========================================
  let activeShareTarget = null;

  function openShareModal(item) {
    activeShareTarget = item;
    $('share-target-name').textContent = `${item.isDirectory ? 'Folder' : 'File'}: ${item.name}`;
    $('share-form-container').style.display = 'block';
    $('share-result-container').style.display = 'none';
    $('share-password').value = '';
    $('share-limit').value = '0';
    openModal('modal-share');
  }

  $('btn-generate-share').onclick = async () => {
    if (!activeShareTarget) return;

    const expiryHours = $('share-expiry').value;
    const password = $('share-password').value;
    const downloadLimit = $('share-limit').value;

    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeShareTarget.relativePath,
          expiryHours,
          password,
          downloadLimit
        })
      });

      if (!res.ok) throw new Error('Could not create share');
      const data = await res.json();
      const shareUrl = `${window.location.origin}/share/${data.share.id}`;

      $('share-form-container').style.display = 'none';
      $('share-result-container').style.display = 'flex';
      $('share-url-output').value = shareUrl;

      // QR Code
      const qrUrl = `/api/qr?text=${encodeURIComponent(shareUrl)}`;
      $('share-qr-img').innerHTML = `<img src="${qrUrl}" style="width:100%; height:100%;" alt="Share QR">`;

      $('btn-copy-share').onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => showToast('Share link copied!', 'success'));
      };

      $('btn-open-share').onclick = () => {
        window.open(shareUrl, '_blank');
      };
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  async function loadShares() {
    try {
      const res = await fetch('/api/shares');
      const shares = await res.json();
      $('nav-shares-count').textContent = shares.length;
      renderShares(shares);
    } catch {
      // ignore
    }
  }

  function renderShares(shares) {
    const list = $('shares-list');
    const empty = $('shares-empty');

    if (!shares || shares.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    shares.forEach((share) => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const shareUrl = `${window.location.origin}/share/${share.id}`;

      row.innerHTML = `
        <div>
          <div class="settings-label">${escapeHtml(share.fileName)}</div>
          <div class="settings-sublabel">
            Downloads: ${share.downloadCount} ${share.downloadLimit ? '/ ' + share.downloadLimit : ''} • 
            ${share.expiryDate ? 'Expires: ' + formatDate(share.expiryDate) : 'Never expires'}
            ${share.hasPassword ? ' • 🔒 Password' : ''}
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary" id="btn-copy-link-${share.id}" style="font-size:0.8rem; padding:4px 10px;">Copy Link</button>
          <button class="btn-secondary" id="btn-revoke-${share.id}" style="font-size:0.8rem; padding:4px 10px; color:var(--color-danger);">Revoke</button>
        </div>
      `;

      row.querySelector(`#btn-copy-link-${share.id}`).onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => showToast('Copied share link', 'success'));
      };

      row.querySelector(`#btn-revoke-${share.id}`).onclick = async () => {
        await fetch(`/api/shares/${share.id}`, { method: 'DELETE' });
        showToast('Share link revoked', 'info');
        loadShares();
      };

      list.appendChild(row);
    });
  }

  // ==========================================
  // Lightbox & Fullscreen Viewer
  // ==========================================
  function openLightbox(item) {
    // Collect all previewable files in current folder
    state.lightboxItems = state.items.filter(i => !i.isDirectory);
    state.lightboxIndex = state.lightboxItems.findIndex(i => i.relativePath === item.relativePath);

    if (state.lightboxIndex === -1) {
      state.lightboxItems = [item];
      state.lightboxIndex = 0;
    }

    renderLightboxCurrent();
    $('lightbox').classList.add('active');
  }

  function renderLightboxCurrent() {
    const item = state.lightboxItems[state.lightboxIndex];
    if (!item) return;

    $('lightbox-title').textContent = item.name;
    const content = $('lightbox-content');
    content.innerHTML = '';

    const previewUrl = `/api/preview/${encodeURIComponent(item.relativePath)}`;
    const downloadUrl = `/api/download/${encodeURIComponent(item.relativePath)}`;

    $('btn-lightbox-download').onclick = () => window.location.href = downloadUrl;
    $('btn-lightbox-share').onclick = () => openShareModal(item);

    if (item.category === 'image') {
      const img = document.createElement('img');
      img.src = previewUrl;
      img.alt = item.name;
      content.appendChild(img);
    } else if (item.category === 'video') {
      const video = document.createElement('video');
      video.src = previewUrl;
      video.controls = true;
      video.autoplay = true;
      content.appendChild(video);
    } else if (item.category === 'audio') {
      const audioWrapper = document.createElement('div');
      audioWrapper.style.textAlign = 'center';
      audioWrapper.innerHTML = `
        <div style="font-size: 3rem; margin-bottom: 16px;">🎵</div>
        <audio src="${previewUrl}" controls autoplay style="width: 300px;"></audio>
      `;
      content.appendChild(audioWrapper);
    } else if (item.category === 'code' || item.category === 'document') {
      // Fetch text content
      const pre = document.createElement('pre');
      pre.className = 'lightbox-text-viewer';
      pre.textContent = 'Loading content...';
      content.appendChild(pre);

      fetch(`/api/view-text/${encodeURIComponent(item.relativePath)}`)
        .then(r => r.json())
        .then(data => {
          pre.textContent = data.content || '(Empty file)';
        })
        .catch(() => {
          pre.textContent = 'Preview not available for this binary format. Click Download above to open.';
        });
    } else {
      content.innerHTML = `
        <div style="text-align: center; color: #fff;">
          <div style="font-size: 3.5rem; margin-bottom: 12px;">📁</div>
          <p>No inline preview for this file type.</p>
        </div>
      `;
    }
  }

  function nextLightbox() {
    if (state.lightboxItems.length <= 1) return;
    state.lightboxIndex = (state.lightboxIndex + 1) % state.lightboxItems.length;
    renderLightboxCurrent();
  }

  function prevLightbox() {
    if (state.lightboxItems.length <= 1) return;
    state.lightboxIndex = (state.lightboxIndex - 1 + state.lightboxItems.length) % state.lightboxItems.length;
    renderLightboxCurrent();
  }

  function closeLightbox() {
    $('lightbox').classList.remove('active');
    $('lightbox-content').innerHTML = '';
  }

  $('btn-lightbox-next').onclick = nextLightbox;
  $('btn-lightbox-prev').onclick = prevLightbox;
  $('btn-lightbox-close').onclick = closeLightbox;

  // Touch Swipe for Mobile Lightbox
  function setupTouchSwipe() {
    let touchStartX = 0;
    let touchEndX = 0;

    const lb = $('lightbox');
    lb.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    lb.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      handleSwipe();
    }, { passive: true });

    function handleSwipe() {
      if (touchEndX < touchStartX - 50) nextLightbox();
      if (touchEndX > touchStartX + 50) prevLightbox();
    }
  }

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    if ($('lightbox').classList.contains('active')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowRight') nextLightbox();
      if (e.key === 'ArrowLeft') prevLightbox();
    }
  });

  // ==========================================
  // Modals & Forms (Folder, Rename, Move)
  // ==========================================
  function openModal(id) {
    const el = $(id);
    if (el) el.classList.add('active');
  }

  function closeModal(id) {
    const el = $(id);
    if (el) el.classList.remove('active');
  }

  $$('.modal-close').forEach(btn => {
    btn.onclick = (e) => {
      const modal = e.target.closest('.modal-backdrop');
      if (modal) modal.classList.remove('active');
    };
  });

  // New Folder
  $('btn-new-folder').onclick = () => openNewFolderModal();
  $('fab-new-folder').onclick = () => {
    closeFabMenu();
    openNewFolderModal();
  };

  function openNewFolderModal() {
    $('folder-name-input').value = '';
    openModal('modal-folder');
    setTimeout(() => $('folder-name-input').focus(), 100);
  }

  $('form-new-folder').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('folder-name-input').value.trim();
    if (!name) return;

    try {
      const res = await fetch('/api/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: state.currentFolder, name })
      });
      if (res.ok) {
        closeModal('modal-folder');
        showToast(`Folder "${name}" created`, 'success');
        loadFolder(state.currentFolder);
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to create folder', 'error');
      }
    } catch {
      showToast('Network error', 'error');
    }
  };

  // Rename
  let itemToRename = null;
  function openRenameModal(item) {
    itemToRename = item;
    $('rename-input').value = item.name;
    openModal('modal-rename');
    setTimeout(() => $('rename-input').focus(), 100);
  }

  $('form-rename').onsubmit = async (e) => {
    e.preventDefault();
    if (!itemToRename) return;
    const newName = $('rename-input').value.trim();
    if (!newName || newName === itemToRename.name) return;

    try {
      const res = await fetch('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: itemToRename.relativePath, newName })
      });
      if (res.ok) {
        closeModal('modal-rename');
        showToast('Renamed successfully', 'success');
        loadFolder(state.currentFolder);
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to rename', 'error');
      }
    } catch {
      showToast('Network error', 'error');
    }
  };

  // Move
  let itemsToMove = [];
  function openMoveModal(paths) {
    itemsToMove = paths;
    const tree = $('move-folder-tree');
    tree.innerHTML = `
      <div class="move-dest-item selected" data-folder="" style="padding: 8px; border-radius: var(--radius-sm); cursor: pointer; background: var(--accent-light); font-weight: 600;">
        📁 Root (Home)
      </div>
    `;

    // Add folders from current state
    state.items.filter(i => i.isDirectory).forEach(folder => {
      const div = document.createElement('div');
      div.className = 'move-dest-item';
      div.dataset.folder = folder.relativePath;
      div.style.padding = '8px';
      div.style.borderRadius = 'var(--radius-sm)';
      div.style.cursor = 'pointer';
      div.textContent = `📁 ${folder.name}`;
      div.onclick = () => {
        tree.querySelectorAll('.move-dest-item').forEach(el => {
          el.style.background = 'transparent';
          el.classList.remove('selected');
        });
        div.style.background = 'var(--accent-light)';
        div.classList.add('selected');
      };
      tree.appendChild(div);
    });

    openModal('modal-move');
  }

  $('btn-confirm-move').onclick = async () => {
    const selectedFolderEl = $('move-folder-tree').querySelector('.move-dest-item.selected');
    const destinationFolder = selectedFolderEl ? selectedFolderEl.dataset.folder : '';

    try {
      const res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsToMove, destinationFolder })
      });
      if (res.ok) {
        closeModal('modal-move');
        showToast('Items moved', 'success');
        state.selectedItems.clear();
        updateMultiselectBar();
        loadFolder(state.currentFolder);
      } else {
        showToast('Failed to move items', 'error');
      }
    } catch {
      showToast('Network error', 'error');
    }
  };

  // ==========================================
  // Settings & Theme
  // ==========================================
  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const data = await res.json();
      state.settings = data;

      $('set-theme').value = data.theme || 'system';
      $('set-default-view').value = data.defaultView || 'grid';
      $('set-max-upload').value = data.maxUploadSizeMB || 51200;
      $('set-storage-quota').value = data.storageQuotaMB || 0;
      $('set-auto-delete').value = data.autoDeleteDays || 0;
      $('set-trash-retention').value = data.trashRetentionDays || 30;
    } catch {
      // ignore
    }
  }

  $('btn-save-settings').onclick = async () => {
    const updates = {
      theme: $('set-theme').value,
      defaultView: $('set-default-view').value,
      maxUploadSizeMB: parseInt($('set-max-upload').value, 10),
      storageQuotaMB: parseInt($('set-storage-quota').value, 10),
      autoDeleteDays: parseInt($('set-auto-delete').value, 10),
      trashRetentionDays: parseInt($('set-trash-retention').value, 10)
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        showToast('Settings saved', 'success');
        applyTheme(updates.theme);
      }
    } catch {
      showToast('Error saving settings', 'error');
    }
  };

  $('btn-save-password').onclick = async () => {
    const currentPassword = $('set-current-pass').value;
    const newPassword = $('set-new-pass').value;

    if (!newPassword || newPassword.length < 4) {
      showToast('Password must be at least 4 characters', 'error');
      return;
    }

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json();
      if (res.ok) {
        $('set-current-pass').value = '';
        $('set-new-pass').value = '';
        showToast('Password updated successfully', 'success');
      } else {
        showToast(data.error || 'Failed to change password', 'error');
      }
    } catch {
      showToast('Network error', 'error');
    }
  };

  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem('droplite_theme', theme);

    if (theme === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }

    const currentTheme = document.documentElement.getAttribute('data-theme');
    $('icon-theme-dark').style.display = currentTheme === 'dark' ? 'block' : 'none';
    $('icon-theme-light').style.display = currentTheme === 'light' ? 'block' : 'none';
  }

  $('btn-theme-toggle').onclick = () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };

  // ==========================================
  // View Routing & UI Controls
  // ==========================================
  function switchView(viewName) {
    state.activeView = viewName;

    // Update navigation styles
    $$('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.view === viewName);
    });
    $$('.bottom-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Toggle content views
    $$('.content-view').forEach(view => {
      view.style.display = view.id === `view-${viewName}` ? 'block' : 'none';
    });

    // Subbar visibility (only on files view)
    $('subbar').style.display = viewName === 'files' ? 'flex' : 'none';

    // Close mobile sidebar if open
    $('sidebar').classList.remove('open');

    // Load data for specific view
    if (viewName === 'trash') loadTrash();
    if (viewName === 'shares') loadShares();
    if (viewName === 'quicksend') loadClips();
    if (viewName === 'files') loadFolder(state.currentFolder);
  }

  function setupEventListeners() {
    // Nav links
    $$('.nav-link, .bottom-nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        switchView(el.dataset.view);
      });
    });

    // Mobile Sidebar Menu
    $('btn-mobile-menu').onclick = () => $('sidebar').classList.toggle('open');

    // Filter pills
    $$('.filter-pill').forEach(pill => {
      pill.onclick = () => {
        $$('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.filterType = pill.dataset.filter;
        renderFiles();
      };
    });

    // Sort select
    $('sort-select').onchange = (e) => {
      state.sortBy = e.target.value;
      renderFiles();
    };

    // View toggle (Grid / List)
    $('btn-view-grid').onclick = () => {
      state.viewMode = 'grid';
      localStorage.setItem('droplite_view_mode', 'grid');
      $('btn-view-grid').classList.add('active');
      $('btn-view-list').classList.remove('active');
      renderFiles();
    };

    $('btn-view-list').onclick = () => {
      state.viewMode = 'list';
      localStorage.setItem('droplite_view_mode', 'list');
      $('btn-view-list').classList.add('active');
      $('btn-view-grid').classList.remove('active');
      renderFiles();
    };

    // Search bar
    const searchInput = $('search-input');
    const searchClear = $('search-clear');
    searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      searchClear.classList.toggle('visible', state.searchQuery.length > 0);
      renderFiles();
    };
    searchClear.onclick = () => {
      searchInput.value = '';
      state.searchQuery = '';
      searchClear.classList.remove('visible');
      renderFiles();
    };

    // LAN QR Modal
    $('btn-show-lan-qr').onclick = () => openModal('modal-lan');

    // Mobile FAB
    $('fab-main-btn').onclick = () => {
      $('fab-container').classList.toggle('open');
    };
  }

  function closeFabMenu() {
    $('fab-container').classList.remove('open');
  }

  // ==========================================
  // Toast Notifications Helper
  // ==========================================
  function showToast(message, type = 'info') {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 200ms ease-out';
      setTimeout(() => toast.remove(), 200);
    }, 3500);
  }

  // ==========================================
  // Utility Functions
  // ==========================================
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    const now = new Date();
    const diffHours = (now - date) / (1000 * 60 * 60);

    if (diffHours < 1) {
      const mins = Math.max(1, Math.round((now - date) / (1000 * 60)));
      return `${mins}m ago`;
    }
    if (diffHours < 24) {
      return `${Math.round(diffHours)}h ago`;
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function getDeviceName() {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return 'Android Phone';
    if (/iphone|ipad/i.test(ua)) return 'iPhone / iPad';
    if (/macintosh/i.test(ua)) return 'Mac';
    if (/windows/i.test(ua)) return 'Windows PC';
    if (/linux/i.test(ua)) return 'Linux';
    return 'Web Device';
  }

  // Start the application
  window.addEventListener('DOMContentLoaded', init);
})();
