import path from 'node:path';
import { app, Tray } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { enableAutoStart } from './auto-start';
import { createTray } from './tray';
import { LocalServer } from '../server/local-server';
import { PrinterService } from '../printing/printer.service';
import { PrintQueueService } from '../printing/print-queue.service';
import { PairingTokenService } from '../security/pairing-token.service';

let tray: Tray | null = null;
let localServer: LocalServer | null = null;
let isQuitting = false;

async function bootstrap(): Promise<void> {
  await app.whenReady();
  enableAutoStart();

  const userDataPath = app.getPath('userData');
  const logger = new LoggerService(userDataPath);
  const configDirectory = path.join(userDataPath, 'config');
  const configService = new AppConfigService(configDirectory, logger);
  const printerService = new PrinterService(configService, logger);
  const queueService = new PrintQueueService(logger);
  const pairingTokenService = new PairingTokenService();

  localServer = new LocalServer({
    version: app.getVersion(),
    configService,
    logger,
    queueService,
    printerService,
    pairingTokenService,
  });

  await localServer.start();

  tray = createTray({
    localServer,
    configService,
    onQuit: async () => {
      isQuitting = true;
      await localServer?.stop();
      app.quit();
    },
    onRestart: async () => {
      await localServer?.stop();
      await localServer?.start();
    },
  });

  app.on('window-all-closed', () => {
    // El agente vive en segundo plano y no crea ventanas de trabajo.
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('activate', () => {
    if (!tray || !localServer) {
      void bootstrap();
    }
  });
}

app.on('second-instance', () => {
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

void bootstrap();
