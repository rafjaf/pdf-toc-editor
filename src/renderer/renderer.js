const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let pdfjsLib = null;
let pdfjsReady = null;

const ensurePdfJsLoaded = async () => {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      try {
        const pdfModuleUrl = pathToFileURL(
          path.join(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
        ).toString();
        console.log('[PDF.js] Loading from local module:', pdfModuleUrl);
        pdfjsLib = await import(pdfModuleUrl);
        pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
          path.join(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
        ).toString();
        console.log('[PDF.js] Loaded successfully from local module');
        console.log('[PDF.js] Worker source:', pdfjsLib.GlobalWorkerOptions.workerSrc);
      } catch (error) {
        console.error('[PDF.js] Failed to load from local module:', error);
        throw error;
      }
    })();
  }

  return pdfjsReady;
};

const state = {
  pdf: null,
  pdfData: null,
  outline: [],
  selectedId: null,
  currentPage: 1,
  zoom: 1.1,
  filePath: null,
  history: [],
  historyIndex: -1,
  collapsedNodes: new Set(),
  lastActionName: null
};

const elements = {
  viewer: document.getElementById('viewer'),
  outlineList: document.getElementById('outlineList'),
  dropZone: document.getElementById('dropZone'),
  contextMenu: document.getElementById('contextMenu'),
  currentPage: document.getElementById('currentPage'),
  totalPages: document.getElementById('totalPages'),
  undoBtn: document.getElementById('undo'),
  redoBtn: document.getElementById('redo')
};

const MAX_HISTORY = 10;

const saveHistory = (actionName = 'change') => {
  const snapshot = JSON.parse(JSON.stringify(state.outline));
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push({ snapshot, actionName });
  state.historyIndex++;
  // Keep only MAX_HISTORY steps
  while (state.history.length > MAX_HISTORY + 1) {
    state.history.shift();
    state.historyIndex--;
  }
  updateUndoRedoButtons();
};

const updateUndoRedoButtons = () => {
  const canUndo = state.historyIndex > 0;
  const canRedo = state.historyIndex < state.history.length - 1;
  
  if (elements.undoBtn) {
    elements.undoBtn.disabled = !canUndo;
    if (canUndo) {
      const actionName = state.history[state.historyIndex].actionName;
      elements.undoBtn.title = `Undo: ${actionName}`;
    } else {
      elements.undoBtn.title = 'Nothing to undo';
    }
  }
  
  if (elements.redoBtn) {
    elements.redoBtn.disabled = !canRedo;
    if (canRedo) {
      const actionName = state.history[state.historyIndex + 1].actionName;
      elements.redoBtn.title = `Redo: ${actionName}`;
    } else {
      elements.redoBtn.title = 'Nothing to redo';
    }
  }
};

const undo = () => {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    state.outline = JSON.parse(JSON.stringify(state.history[state.historyIndex].snapshot));
    refreshOutline();
    updateUndoRedoButtons();
  }
};

const redo = () => {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    state.outline = JSON.parse(JSON.stringify(state.history[state.historyIndex].snapshot));
    refreshOutline();
    updateUndoRedoButtons();
  }
};

const startRename = () => {
  if (!state.selectedId) return;
  const item = state.outline.find(entry => entry.id === state.selectedId);
  if (!item) return;
  
  const row = elements.outlineList.querySelector(`[data-id="${state.selectedId}"]`);
  if (!row) return;
  
  const title = row.querySelector('.outline-title');
  const input = document.createElement('input');
  input.value = item.title;
  input.className = 'outline-input';
  
  // Stop clicks inside input from triggering row click or blur
  input.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  
  input.addEventListener('blur', () => {
    saveHistory('Rename title');
    item.title = input.value || 'Untitled';
    refreshOutline();
  });
  
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      input.blur();
    } else if (event.key === 'Escape') {
      refreshOutline();
    }
  });
  
  title.replaceWith(input);
  input.focus();
  input.select();
};

const outlineActions = {
  add: () => addOutlineItem({ asChild: false }),
  addChild: () => addOutlineItem({ asChild: true }),
  delete: () => deleteOutlineItem(),
  indent: () => adjustLevel(1),
  outdent: () => adjustLevel(-1),
  moveUp: () => moveItem(-1),
  moveDown: () => moveItem(1),
  rename: () => startRename(),
  setPage: () => openPageModal()
};

const refreshOutline = () => {
  elements.outlineList.innerHTML = '';

  if (state.outline.length === 0) {
    elements.outlineList.innerHTML = '<div class="empty-state">No outline yet. Add a title to begin.</div>';
    return;
  }

  // Use DocumentFragment for batched DOM operations (better performance for large outlines)
  const fragment = document.createDocumentFragment();

  state.outline.forEach((item, index) => {
    const hasChildren = index < state.outline.length - 1 && state.outline[index + 1].level > item.level;
    const isCollapsed = state.collapsedNodes.has(item.id);
    const isHidden = shouldHideItem(item, index);
    
    if (isHidden) return;

    // Check if this is the last child at its level (for the L-shaped connector)
    let isLastChild = true;
    for (let i = index + 1; i < state.outline.length; i++) {
      if (state.outline[i].level < item.level) {
        break;
      }
      if (state.outline[i].level === item.level) {
        isLastChild = false;
        break;
      }
    }

    // Determine which ancestor levels need vertical lines (continuing down)
    const ancestorLines = new Set();
    for (let level = 0; level < item.level; level++) {
      for (let i = index + 1; i < state.outline.length; i++) {
        if (state.outline[i].level < level) break;
        if (state.outline[i].level === level) {
          ancestorLines.add(level);
          break;
        }
      }
    }

    const row = document.createElement('div');
    row.className = `outline-item ${item.id === state.selectedId ? 'active' : ''}`;
    row.draggable = true;
    row.dataset.id = item.id;
    row.dataset.index = index;

    // Create tree indentation with lines
    if (item.level > 0) {
      const treeIndent = document.createElement('div');
      treeIndent.className = 'tree-indent';
      
      for (let lvl = 0; lvl < item.level; lvl++) {
        const segment = document.createElement('div');
        segment.className = 'tree-segment';
        
        if (lvl === item.level - 1) {
          // This is the connector segment (L or T shape)
          segment.classList.add('connector');
          if (!isLastChild) {
            segment.classList.add('continue');
          }
        } else if (ancestorLines.has(lvl)) {
          // This is a pass-through vertical line
          segment.classList.add('has-line');
        }
        
        treeIndent.appendChild(segment);
      }
      row.appendChild(treeIndent);
    }

    const toggle = document.createElement('span');
    toggle.className = 'outline-toggle';
    toggle.textContent = hasChildren ? (isCollapsed ? '▶' : '▼') : '•';
    if (hasChildren) {
      toggle.style.cursor = 'pointer';
    }
    
    if (hasChildren) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCollapsed) {
          state.collapsedNodes.delete(item.id);
        } else {
          state.collapsedNodes.add(item.id);
        }
        refreshOutline();
      });
    }

    const title = document.createElement('span');
    title.className = 'outline-title';
    title.textContent = item.title;
    title.style.flex = '1';

    row.append(toggle, title);
    fragment.append(row);

    row.addEventListener('click', () => {
      state.selectedId = item.id;
      refreshOutline();
      scrollToPage(item.pageIndex + 1);
    });

    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startRename();
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      state.selectedId = item.id;
      refreshOutline();
      openContextMenu(event.clientX, event.clientY);
    });

    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', index.toString());
    });
  });

  // Append all at once for better performance
  elements.outlineList.appendChild(fragment);
};

const shouldHideItem = (item, index) => {
  // Check if any ancestor is collapsed
  for (let i = index - 1; i >= 0; i--) {
    const ancestor = state.outline[i];
    // Found a potential parent (lower level means higher in hierarchy)
    if (ancestor.level < item.level) {
      // If this ancestor is collapsed, hide this item
      if (state.collapsedNodes.has(ancestor.id)) {
        return true;
      }
    }
    // If we encounter an item at the same level or higher, it's not an ancestor
    if (ancestor.level <= item.level && i < index - 1) {
      // Continue checking for other potential ancestors
      continue;
    }
  }
  return false;
};

const addOutlineItem = ({ asChild }) => {
  if (!state.pdf) return;

  saveHistory(asChild ? 'Add nested title' : 'Add title');
  const baseIndex = state.outline.findIndex((item) => item.id === state.selectedId);
  const insertIndex = baseIndex >= 0 ? baseIndex + 1 : state.outline.length;
  const baseLevel = baseIndex >= 0 ? state.outline[baseIndex].level : 0;
  const level = asChild ? Math.min(baseLevel + 1, 6) : baseLevel;

  const item = {
    id: crypto.randomUUID(),
    title: 'New Title',
    pageIndex: state.currentPage - 1,
    level
  };

  state.outline.splice(insertIndex, 0, item);
  state.selectedId = item.id;
  refreshOutline();
};

const deleteOutlineItem = () => {
  if (!state.selectedId) return;
  const index = state.outline.findIndex((item) => item.id === state.selectedId);
  if (index >= 0) {
    saveHistory('Delete title');
    state.outline.splice(index, 1);
    state.selectedId = state.outline[index]?.id ?? state.outline[index - 1]?.id ?? null;
    refreshOutline();
  }
};

const adjustLevel = (delta) => {
  const item = state.outline.find((entry) => entry.id === state.selectedId);
  if (!item) return;
  saveHistory(delta > 0 ? 'Indent title' : 'Outdent title');
  item.level = Math.max(0, item.level + delta);
  refreshOutline();
};

const moveItem = (delta) => {
  const index = state.outline.findIndex((item) => item.id === state.selectedId);
  if (index < 0) return;
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= state.outline.length) return;
  saveHistory(delta < 0 ? 'Move title up' : 'Move title down');
  const [removed] = state.outline.splice(index, 1);
  state.outline.splice(nextIndex, 0, removed);
  refreshOutline();
};

const openContextMenu = (x, y) => {
  elements.contextMenu.style.display = 'flex';
  
  // Position initially to measure size
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;
  
  // Adjust if it would overflow the bottom
  const menuRect = elements.contextMenu.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  if (menuRect.bottom > windowHeight) {
    const adjustedY = windowHeight - menuRect.height - 8;
    elements.contextMenu.style.top = `${Math.max(8, adjustedY)}px`;
  }
  
  // Adjust if it would overflow the right
  const windowWidth = window.innerWidth;
  if (menuRect.right > windowWidth) {
    const adjustedX = windowWidth - menuRect.width - 8;
    elements.contextMenu.style.left = `${Math.max(8, adjustedX)}px`;
  }
};

const closeContextMenu = () => {
  elements.contextMenu.style.display = 'none';
};

const scrollToPage = (pageNumber) => {
  const page = elements.viewer.querySelector(`[data-page-number="${pageNumber}"]`);
  if (page) {
    const distance = Math.abs(pageNumber - state.currentPage);
    const behavior = distance > 10 ? 'instant' : 'smooth';
    page.scrollIntoView({ behavior, block: 'start' });
  }
};

const setPageIndicators = () => {
  elements.currentPage.textContent = state.currentPage;
  elements.totalPages.textContent = state.pdf ? state.pdf.numPages : 1;
};

const renderPdf = async () => {
  if (!state.pdf) return;

  elements.viewer.innerHTML = '';
  const pageCount = state.pdf.numPages;
  elements.totalPages.textContent = pageCount;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await state.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: state.zoom });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.pageNumber = pageNumber.toString();

    wrapper.appendChild(canvas);
    elements.viewer.appendChild(wrapper);

    await page.render({ canvasContext: context, viewport }).promise;
  }

  observePages();
};

const observePages = () => {
  const pageElements = Array.from(elements.viewer.querySelectorAll('.pdf-page'));
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length > 0) {
        const top = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const pageNumber = Number(top.target.dataset.pageNumber || 1);
        if (state.currentPage !== pageNumber) {
          state.currentPage = pageNumber;
          setPageIndicators();
        }
      }
    },
    { root: elements.viewer, threshold: 0.4 }
  );

  pageElements.forEach((element) => observer.observe(element));
};

const collapseAll = () => {
  state.outline.forEach((item, index) => {
    const hasChildren = index < state.outline.length - 1 && state.outline[index + 1].level > item.level;
    if (hasChildren) {
      state.collapsedNodes.add(item.id);
    }
  });
  refreshOutline();
};

const expandAll = () => {
  state.collapsedNodes.clear();
  refreshOutline();
};

const loadPdfData = async ({ data, filePath, outline = [] }) => {
  await ensurePdfJsLoaded();
  state.filePath = filePath;
  state.pdfData = data;
  state.pdf = await pdfjsLib.getDocument({ data }).promise;
  state.outline = outline.map((item) => ({
    id: item.id ?? crypto.randomUUID(),
    title: item.title ?? 'Untitled',
    pageIndex: item.pageIndex ?? 0,
    level: item.level ?? 0
  }));
  state.currentPage = 1;
  state.history = [{ snapshot: JSON.parse(JSON.stringify(state.outline)), actionName: 'Open file' }];
  state.historyIndex = 0;
  state.collapsedNodes.clear();
  setPageIndicators();
  updateUndoRedoButtons();
  elements.dropZone.style.display = 'none';
  
  // Refresh outline BEFORE rendering PDF pages so it shows immediately
  refreshOutline();
  
  // Allow the browser to paint the outline before starting heavy PDF rendering
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  await renderPdf();
};

const handleDrop = async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const data = await file.arrayBuffer();
  await loadPdfData({ data, filePath: file.path, outline: [] });
};

const requestOpenPdf = async () => {
  const result = await ipcRenderer.invoke('open-pdf-dialog');
  if (!result) return;
  await loadPdfData({
    data: result.data,
    filePath: result.filePath,
    outline: result.outline
  });
};

const requestSavePdf = async () => {
  if (!state.pdfData || !state.filePath) {
    return;
  }
  await ipcRenderer.invoke('save-pdf', {
    sourcePath: state.filePath,
    outline: state.outline
  });
};

const requestSavePdfAs = async () => {
  if (!state.pdfData) {
    return;
  }
  const result = await ipcRenderer.invoke('save-pdf-as', {
    sourcePath: state.filePath,
    outline: state.outline
  });
  if (result && result.filePath) {
    state.filePath = result.filePath;
  }
};

const openPageModal = () => {
  if (!state.selectedId) return;
  const item = state.outline.find(entry => entry.id === state.selectedId);
  if (!item) return;
  
  const modal = document.getElementById('pageModal');
  const input = document.getElementById('pageInput');
  input.value = item.pageIndex + 1;
  input.max = state.pdf?.numPages ?? 1;
  modal.style.display = 'flex';
  input.focus();
  input.select();
};

const closePageModal = () => {
  document.getElementById('pageModal').style.display = 'none';
};

const confirmPageModal = () => {
  if (!state.selectedId) return;
  const item = state.outline.find(entry => entry.id === state.selectedId);
  if (!item) return;
  
  const input = document.getElementById('pageInput');
  const pageNumber = parseInt(input.value, 10);
  if (!isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= (state.pdf?.numPages ?? 1)) {
    saveHistory('Set target page');
    item.pageIndex = pageNumber - 1;
    refreshOutline();
  }
  closePageModal();
};

document.getElementById('openPdf').addEventListener('click', requestOpenPdf);
document.getElementById('savePdf').addEventListener('click', requestSavePdf);
document.getElementById('savePdfAs').addEventListener('click', requestSavePdfAs);

document.getElementById('addTitle').addEventListener('click', () => outlineActions.add());
document.getElementById('addChild').addEventListener('click', () => outlineActions.addChild());
document.getElementById('renameTitle').addEventListener('click', () => outlineActions.rename());
document.getElementById('setPage').addEventListener('click', () => outlineActions.setPage());
document.getElementById('deleteTitle').addEventListener('click', () => outlineActions.delete());
document.getElementById('indentTitle').addEventListener('click', () => outlineActions.indent());
document.getElementById('outdentTitle').addEventListener('click', () => outlineActions.outdent());
document.getElementById('moveUp').addEventListener('click', () => outlineActions.moveUp());
document.getElementById('moveDown').addEventListener('click', () => outlineActions.moveDown());
document.getElementById('expandAll').addEventListener('click', () => expandAll());
document.getElementById('collapseAll').addEventListener('click', () => collapseAll());
document.getElementById('undo').addEventListener('click', () => undo());
document.getElementById('redo').addEventListener('click', () => redo());

document.getElementById('prevPage').addEventListener('click', () => scrollToPage(Math.max(1, state.currentPage - 1)));
document.getElementById('nextPage').addEventListener('click', () => scrollToPage(Math.min(state.pdf?.numPages ?? 1, state.currentPage + 1)));

document.getElementById('zoomSlider').addEventListener('input', async (event) => {
  state.zoom = Number(event.target.value) / 100;
  await renderPdf();
});

elements.outlineList.addEventListener('dragover', (event) => {
  event.preventDefault();
});

elements.outlineList.addEventListener('drop', (event) => {
  event.preventDefault();
  const sourceIndex = Number(event.dataTransfer.getData('text/plain'));
  const target = event.target.closest('.outline-item');
  if (!target) return;
  const targetIndex = Number(target.dataset.index);
  const [removed] = state.outline.splice(sourceIndex, 1);
  state.outline.splice(targetIndex, 0, removed);
  refreshOutline();
});

elements.viewer.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.style.display = 'flex';
});

elements.viewer.addEventListener('dragleave', () => {
  if (!state.pdf) {
    elements.dropZone.style.display = 'flex';
  }
});

elements.viewer.addEventListener('drop', handleDrop);

document.addEventListener('click', () => closeContextMenu());

elements.contextMenu.addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  if (action && outlineActions[action]) {
    outlineActions[action]();
  }
  closeContextMenu();
});

const divider = document.getElementById('divider');
const outlinePane = document.getElementById('outlinePane');
let resizing = false;

divider.addEventListener('mousedown', () => {
  resizing = true;
  document.body.style.cursor = 'col-resize';
});

document.addEventListener('mouseup', () => {
  resizing = false;
  document.body.style.cursor = 'default';
});

document.addEventListener('mousemove', (event) => {
  if (!resizing) return;
  const newWidth = Math.min(Math.max(event.clientX, 220), 480);
  outlinePane.style.width = `${newWidth}px`;
  outlinePane.style.flex = '0 0 auto';
});

// Page modal events
document.getElementById('pageModalCancel').addEventListener('click', closePageModal);
document.getElementById('pageModalOk').addEventListener('click', confirmPageModal);
document.getElementById('pageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    confirmPageModal();
  } else if (event.key === 'Escape') {
    closePageModal();
  }
});
document.getElementById('pageModal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closePageModal();
  }
});

// Initialize version display
ipcRenderer.invoke('get-app-version').then((version) => {
  document.getElementById('appVersion').textContent = `v${version}`;
});

setPageIndicators();
refreshOutline();
