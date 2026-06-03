import log from 'electron-log/main';
import electronUpdater, {
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from 'electron-updater';
import { app } from 'electron';
import { LoggerService } from '../logs/logger.service';

const { autoUpdater } = electronUpdater;

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 15_000;

interface AutoUpdateDependencies {
  logger: LoggerService;
  notify?: (title: string, content: string) => void;
}

export function startAutoUpdater({
  logger,
  notify,
}: AutoUpdateDependencies): () => void {
  if (process.platform !== 'win32') {
    logger.info('Auto-update omitido: el agente solo busca updates automaticos en Windows.');
    return () => undefined;
  }

  if (!app.isPackaged) {
    logger.info('Auto-update omitido: la aplicacion esta corriendo en modo desarrollo.');
    return () => undefined;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logger.info('Buscando actualizaciones del agente.');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info('Actualizacion disponible para el agente.', {
      version: info.version,
      releaseDate: info.releaseDate,
    });
    notify?.(
      'Actualizacion disponible',
      `Se encontro la version ${info.version} y se descargara en segundo plano.`,
    );
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logger.info('No hay actualizaciones nuevas para el agente.', {
      version: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    logger.info('Descargando actualizacion del agente.', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    logger.info('Actualizacion descargada. Se instalara al cerrar la app.', {
      version: info.version,
      releaseDate: info.releaseDate,
    });
    notify?.(
      'Actualizacion lista',
      `La version ${info.version} ya se descargo y se instalara cuando cierres el agente.`,
    );
  });

  autoUpdater.on('error', (error: Error) => {
    logger.warn('No fue posible completar la busqueda de actualizaciones.', {
      message: error.message,
      note:
        'Si el repositorio de releases es privado, los clientes necesitaran credenciales o deberas publicar los binarios en un origen publico.',
    });
  });

  const initialTimeout = setTimeout(() => {
    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      logger.warn('La comprobacion inicial de actualizaciones fallo.', error);
    });
  }, INITIAL_UPDATE_CHECK_DELAY_MS);

  const intervalId = setInterval(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      logger.warn('La comprobacion periodica de actualizaciones fallo.', error);
    });
  }, UPDATE_CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(initialTimeout);
    clearInterval(intervalId);
    autoUpdater.removeAllListeners();
  };
}
