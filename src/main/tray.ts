import path from 'node:path';
import { app, Menu, Tray, nativeImage, shell } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LocalServer } from '../server/local-server';

interface TrayDependencies {
  localServer: LocalServer;
  configService: AppConfigService;
  onOpenMonitor: () => Promise<void>;
  onQuit: () => void;
  onRestart: () => Promise<void>;
}

export function createTray(dependencies: TrayDependencies): Tray {
  const tray = new Tray(buildTrayIcon());
  tray.setToolTip('Gestion al Dia Print Agent');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Gestion al Dia Print Agent',
      enabled: false,
    },
    {
      label: 'Ver historial de impresiones',
      click: async () => {
        await dependencies.onOpenMonitor();
      },
    },
    {
      label: 'Abrir carpeta de configuracion',
      click: async () => {
        const configPath = dependencies.configService.getConfigPath();
        await shell.showItemInFolder(configPath);
      },
    },
    {
      label: 'Reiniciar servicio local',
      click: async () => {
        await dependencies.onRestart();
      },
    },
    {
      label: 'Salir',
      click: () => {
        dependencies.onQuit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  return tray;
}

function buildTrayIcon() {
  const baseIconDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'build')
    : path.join(app.getAppPath(), 'build');

  const iconCandidates = ['tray-icon.png', 'icon.ico'];

  for (const fileName of iconCandidates) {
    const iconPath = path.join(baseIconDirectory, fileName);
    const icon = nativeImage.createFromPath(iconPath);

    if (!icon.isEmpty()) {
      return icon.resize({ width: 16, height: 16, quality: 'best' });
    }
  }

  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAeFBMVEVHcEyAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvSAlvQevnyrAAAAJ3RSTlMAAwgQFiIlLz5AR1JZXGJqdX+Ah5Kcoq+1xN3f6vL0+P3+TAw6mAAAAJVJREFUGNNjYMAKZmFlYWVj5+Dk4ubh5eMXEBQSFhEVE5eQlJKWkZWTV1BUUlZT19DU0tbR1dM3MjYxNTO3sbWxBQAtdQx2Sv8UUQAAAABJRU5ErkJggg==',
  );
}
