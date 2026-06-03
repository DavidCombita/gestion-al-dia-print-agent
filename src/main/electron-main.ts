import path from 'node:path';
import { app, Tray } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { enableAutoStart } from './auto-start';
import { startAutoUpdater } from './auto-updater';
import { openMonitorWindow } from './monitor-window';
import { createTray } from './tray';
import { LocalServer } from '../server/local-server';
import { PrintHistoryService } from '../printing/print-history.service';
import { PrinterService } from '../printing/printer.service';
import { PrintQueueService } from '../printing/print-queue.service';
import { PairingTokenService } from '../security/pairing-token.service';

let tray: Tray | null = null;
let localServer: LocalServer | null = null;
let isQuitting = false;
let loggerInstance: LoggerService | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let stopAutoUpdater: (() => void) | null = null;
let runtimeStartedAt = Date.now();

const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
const SERVER_WATCHDOG_INTERVAL_MS = 15_000;

if (!SINGLE_INSTANCE_LOCK) {
  app.quit();
}

async function bootstrap(): Promise<void> {
  if (!SINGLE_INSTANCE_LOCK) {
    return;
  }

  await app.whenReady();

  if (localServer && tray) {
    startWatchdog();
    await ensureLocalServerStarted();
    return;
  }

  enableAutoStart();

  const userDataPath = app.getPath('userData');
  const logger = loggerInstance ?? new LoggerService(userDataPath);
  loggerInstance = logger;
  const configDirectory = path.join(userDataPath, 'config');
  const historyDirectory = path.join(userDataPath, 'history');
  const configService = new AppConfigService(configDirectory, logger);
  const printHistoryService = new PrintHistoryService(historyDirectory, logger);
  const printerService = new PrinterService(configService, logger);
  const queueService = new PrintQueueService(logger);
  const pairingTokenService = new PairingTokenService();

  localServer = new LocalServer({
    version: app.getVersion(),
    startedAt: runtimeStartedAt,
    configService,
    logger,
    queueService,
    printerService,
    printHistoryService,
    pairingTokenService,
    onServerUnavailable: (reason, error) => {
      logger.warn('El servidor local reporto una falla y se intentara recuperar.', {
        reason,
        error,
      });
      scheduleRestart(reason);
    },
  });

  await ensureLocalServerStarted();
  startWatchdog();

  tray = createTray({
    localServer,
    configService,
    onOpenMonitor: async () => {
      if (!localServer) {
        return;
      }

      await ensureLocalServerStarted();
      await openMonitorWindow(new URL('monitor', localServer.getBaseUrl()).toString());
    },
    onQuit: async () => {
      isQuitting = true;
      stopWatchdog();
      clearScheduledRestart();
      await localServer?.stop();
      app.quit();
    },
    onRestart: async () => {
      await restartLocalServer('manual');
    },
  });

  stopAutoUpdater?.();
  stopAutoUpdater = startAutoUpdater({
    logger,
    notify: (title, content) => {
      tray?.displayBalloon?.({
        title,
        content,
      });
    },
  });

  app.on('window-all-closed', () => {
    // El agente vive en segundo plano y no crea ventanas de trabajo.
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopWatchdog();
    clearScheduledRestart();
    stopAutoUpdater?.();
    stopAutoUpdater = null;
  });

  app.on('activate', () => {
    if (!tray || !localServer) {
      void bootstrap();
      return;
    }

    if (!localServer.isRunning()) {
      void restartLocalServer('activate');
    }
  });
}

app.on('second-instance', () => {
  if (localServer && !localServer.isRunning()) {
    void restartLocalServer('second-instance');
  } else if (!localServer) {
    void bootstrap();
  }

  tray?.displayBalloon?.({
    title: 'Gestion al Dia Print Agent',
    content: 'El agente local ya se encuentra en ejecucion.',
  });
});

app.on('will-quit', async (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  await localServer?.stop();
  app.quit();
});

process.on('uncaughtException', (error) => {
  loggerInstance?.error('Excepcion no controlada en el agente.', error);
  void restartLocalServer('uncaught-exception');
});

process.on('unhandledRejection', (reason) => {
  loggerInstance?.error('Promesa rechazada sin manejo en el agente.', reason);
  scheduleRestart('unhandled-rejection');
});

void bootstrap();

async function ensureLocalServerStarted(): Promise<void> {
  if (!localServer) {
    return;
  }

  try {
    await localServer.start();
  } catch (error) {
    loggerInstance?.error('No fue posible iniciar el servidor local.', error);
    scheduleRestart('startup-failure');
  }
}

async function restartLocalServer(reason: string): Promise<void> {
  if (!localServer || isQuitting) {
    return;
  }

  clearScheduledRestart();
  loggerInstance?.warn('Reiniciando servidor local.', { reason });

  try {
    await localServer.stop();
  } catch (error) {
    loggerInstance?.warn('El servidor local fallo al detenerse durante el reinicio.', error);
  }

  try {
    await localServer.start();
    loggerInstance?.info('Servidor local reiniciado correctamente.', { reason });
  } catch (error) {
    loggerInstance?.error('Fallo el reinicio del servidor local.', error);
    scheduleRestart('restart-failure');
  }
}

function scheduleRestart(reason: string): void {
  if (restartTimer || isQuitting) {
    return;
  }

  loggerInstance?.warn('Programando reinicio automatico del servidor local.', { reason });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartLocalServer(reason);
  }, 5_000);
}

function clearScheduledRestart(): void {
  if (!restartTimer) {
    return;
  }

  clearTimeout(restartTimer);
  restartTimer = null;
}

function startWatchdog(): void {
  if (watchdogTimer || isQuitting) {
    return;
  }

  watchdogTimer = setInterval(() => {
    if (!localServer || isQuitting) {
      return;
    }

    if (!localServer.isRunning()) {
      loggerInstance?.warn('Watchdog detecto que el servidor local dejo de escuchar.');
      scheduleRestart('watchdog-server-not-running');
    }
  }, SERVER_WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (!watchdogTimer) {
    return;
  }

  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
