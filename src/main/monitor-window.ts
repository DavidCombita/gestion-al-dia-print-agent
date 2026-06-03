import { BrowserWindow } from 'electron';

let monitorWindow: BrowserWindow | null = null;

export async function openMonitorWindow(url: string): Promise<void> {
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    monitorWindow.show();
    monitorWindow.focus();
    await monitorWindow.loadURL(url);
    return;
  }

  monitorWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    autoHideMenuBar: true,
    title: 'Gestion al Dia Print Agent',
    backgroundColor: '#f4f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  monitorWindow.on('closed', () => {
    monitorWindow = null;
  });

  await monitorWindow.loadURL(url);
  monitorWindow.show();
}
