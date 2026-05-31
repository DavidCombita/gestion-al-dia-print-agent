import { Menu, Tray, nativeImage, shell } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LocalServer } from '../server/local-server';

interface TrayDependencies {
  localServer: LocalServer;
  configService: AppConfigService;
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
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAr0lEQVR4AYXQMQrCQBRF0f9xQ7QWVi4v0hN4G8GSsLG3sLS0sLMQbCys7Ky9hULRCQnydQ4M2M6T3JmZkfrGNzm1jzA6hhgmyE91Csr4Y4l+WQy+7AORn8YZg5hKnk0V9H+g7WIXqVUw0aPE0xRjWiWFy20tqJ6JnhLtAz4VTAkEmXjGGp8f7tDU9fBHs4IYlQ0h11+g63r0G/kTuv8V6oB4w7OZjNDiZdAAAAAElFTkSuQmCC',
  );
}
