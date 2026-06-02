const { app, BrowserWindow, ipcMain } = require('electron');

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d1a',
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');
});

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => win?.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('win:close',    () => win?.close());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
