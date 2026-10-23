'use strict';
// Системный диалог выбора папки (Electron). Возвращает путь или null.
const { path } = require('../platform');

async function pickFolder() {
  try {
    const electron = require('electron');
    const dialog = electron.remote && electron.remote.dialog;
    if (dialog) {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    }
  } catch (e) { /* падаем на запасной вариант */ }

  // Запасной вариант: <input webkitdirectory>. На очень больших архивах браузер сначала перечисляет все файлы
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      let filePath = file.path;
      try {
        const { webUtils } = require('electron');
        if (webUtils && webUtils.getPathForFile) filePath = webUtils.getPathForFile(file);
      } catch (e) { /* старые версии Electron */ }
      if (!filePath) return resolve(null);
      let dir = filePath;
      const depth = file.webkitRelativePath.split('/').length - 1;
      for (let i = 0; i < depth; i++) dir = path.dirname(dir);
      resolve(dir);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Выбор файла (например, ZIP). Возвращает путь или null.
async function pickFile(extensions = ['zip']) {
  try {
    const electron = require('electron');
    const dialog = electron.remote && electron.remote.dialog;
    if (dialog) {
      const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: extensions.join(', '), extensions }] });
      return r.canceled ? null : r.filePaths[0];
    }
  } catch (e) { /* падаем на запасной вариант */ }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => `.${e}`).join(',');
    input.onchange = () => resolve(pathOfFile(input.files && input.files[0]));
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Выбор файла как объекта File (телефон): читается кусками, без пути на диске. Возвращает File или null.
function pickFileObject(extensions = ['zip']) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => `.${e}`).join(',');
    input.onchange = () => resolve((input.files && input.files[0]) || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Путь файла из браузерного File (Electron даёт его через file.path или webUtils)
function pathOfFile(file) {
  if (!file) return null;
  try {
    const { webUtils } = require('electron');
    if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file) || null;
  } catch (e) { /* старые версии Electron */ }
  return file.path || null;
}

module.exports = { pickFolder, pickFile, pickFileObject, pathOfFile };
