import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { applyOutlineToPdf, extractOutline } from '../shared/outline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const APP_VERSION = packageJson.version;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'PDF Outline Editor',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
};

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('open-pdf-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const filePath = filePaths[0];
  const data = await readFile(filePath);
  const outline = await extractOutline(data);
  return { filePath, data: data.buffer, outline };
});

// Save (overwrite original with backup)
ipcMain.handle('save-pdf', async (_event, { sourcePath, outline }) => {
  if (!sourcePath) {
    return null;
  }

  // Create backup
  const backupPath = sourcePath + '.backup';
  try {
    await copyFile(sourcePath, backupPath);
  } catch (err) {
    console.error('Failed to create backup:', err);
  }

  const sourceData = await readFile(sourcePath);
  const updated = await applyOutlineToPdf(sourceData, outline);
  await writeFile(sourcePath, Buffer.from(updated));
  return { filePath: sourcePath };
});

// Save As (choose new location)
ipcMain.handle('save-pdf-as', async (_event, { sourcePath, outline }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save PDF As',
    defaultPath: sourcePath ?? 'outline.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });

  if (canceled || !filePath) {
    return null;
  }

  const sourceData = await readFile(sourcePath);
  const updated = await applyOutlineToPdf(sourceData, outline);
  await writeFile(filePath, Buffer.from(updated));
  return { filePath };
});
