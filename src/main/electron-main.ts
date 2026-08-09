import path from 'node:path';
import { app, Tray } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { enableAutoStart } from './auto-start';
import { startAutoUpdater } from './auto-updater';
import { openMonitorWindow } from './monitor-window';
import { createTray } from './tray';
import { LocalServer } from '../server/local-server';
import { PrintHistoryService } from '../printing/history/print-history.service';
import { PairingTokenService } from '../security/pairing-token.service';
import { BackendPrintClientService } from '../backend/backend-print-client.service';
import { PrintFormatterRegistry } from '../printing/formatters/print-formatter.registry';
import { PrintOrchestratorService } from '../printing/print-orchestrator.service';
import { PrintDiagnosticsService } from '../printing/diagnostics/print-diagnostics.service';
import { WindowsPrintDiagnosticsService } from '../printing/diagnostics/windows-print-diagnostics.service';
import { PrinterDiscoveryService } from '../printing/printers/printer-discovery.service';
import { PrinterProfileService } from '../printing/printers/printer-profile.service';
import { PrinterQueueService } from '../printing/queue/printer-queue.service';
import { PrintTransportRegistry } from '../printing/transports/print-transport.registry';
import { WindowsDriverTransport } from '../printing/transports/windows-driver.transport';
import { WindowsRawTransport } from '../printing/transports/windows-raw.transport';
import { SpoolJobMonitorService } from '../printing/windows/spool-job-monitor.service';
import { WinSpoolAdapter } from '../printing/windows/winspool-adapter';

let tray: Tray | null = null;
let localServer: LocalServer | null = null;
let backendPrintClient: BackendPrintClientService | null = null;
let printTransportRegistry: PrintTransportRegistry | null = null;
let isQuitting = false;
let shutdownCompleted = false;
let shutdownPromise: Promise<void> | null = null;
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

/**
 * Inicializa el proceso principal de Electron y conecta todos los servicios del agente.
 *
 * La funcion es intencionalmente idempotente: si el tray y el servidor ya existen, solo
 * reactiva el watchdog y asegura que el servidor local siga escuchando. En el primer
 * arranque crea configuracion, historial, cola, impresoras, cliente backend, servidor
 * local, tray, auto-updater y handlers del ciclo de vida de Electron.
 */
async function bootstrap(): Promise<void> {
  if (!SINGLE_INSTANCE_LOCK) {
    return;
  }

  await app.whenReady();

  //inicar el servidor local
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
  const config = configService.getConfig();
  const printHistoryService = new PrintHistoryService(historyDirectory, logger);
  const winSpoolAdapter = new WinSpoolAdapter(logger);
  const printerDiscoveryService = new PrinterDiscoveryService(winSpoolAdapter, logger);
  const printerProfileService = new PrinterProfileService(configService);
  const queueService = new PrinterQueueService(
    logger,
    config.maxPendingPrintJobsPerPrinter,
  );
  const rawTransport = new WindowsRawTransport(winSpoolAdapter);
  const driverTransport = new WindowsDriverTransport();
  const transportRegistry = new PrintTransportRegistry([
    rawTransport,
    driverTransport,
  ]);
  printTransportRegistry = transportRegistry;
  const spoolJobMonitorService = new SpoolJobMonitorService(logger, {
    pollIntervalMs: config.printJobPollIntervalMs,
    completionTimeoutMs: config.printJobCompletionTimeoutMs,
  });
  const printOrchestrator = new PrintOrchestratorService({
    formatterRegistry: new PrintFormatterRegistry(),
    profileService: printerProfileService,
    queueService,
    historyService: printHistoryService,
    transportRegistry,
    monitorService: spoolJobMonitorService,
    printerDiscoveryService,
    logger,
  });
  const printDiagnosticsService = new PrintDiagnosticsService(
    printOrchestrator,
    printerProfileService,
    printerDiscoveryService,
    queueService,
    printHistoryService,
    new WindowsPrintDiagnosticsService(),
    {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      arch: process.arch,
    },
  );
  const pairingTokenService = new PairingTokenService();
  backendPrintClient = new BackendPrintClientService({
    version: app.getVersion(),
    configService,
    logger,
    printerDiscoveryService,
    printOrchestrator,
    // El cliente backend se puede inicializar antes del tray; por eso se usa acceso opcional.
    notify: (title, content) => {
      tray?.displayBalloon?.({
        title,
        content,
      });
    },
  });

  localServer = new LocalServer({
    version: app.getVersion(),
    startedAt: runtimeStartedAt,
    configService,
    logger,
    queueService,
    printerDiscoveryService,
    printerProfileService,
    printOrchestrator,
    printDiagnosticsService,
    printHistoryService,
    pairingTokenService,
    backendPrintClient,
    // LocalServer reporta fallas recuperables por este callback; el reinicio se agenda fuera
    // del stack de la peticion para evitar reentradas durante el manejo del error.
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
    // Salida explicita desde la bandeja: apaga timers y conexiones antes de cerrar Electron.
    onQuit: async () => {
      isQuitting = true;
      await shutdownRuntime();
      shutdownCompleted = true;
      app.quit();
    },
    onRestart: async () => {
      await restartLocalServer('manual');
    },
  });

  await logPrintingRuntime(printerDiscoveryService, logger);
  let reconciliationSucceeded = true;

  try {
    const recoveredJobs = await printOrchestrator.reconcilePendingJobs();
    logger.info('Reconciliacion inicial de trabajos de impresion finalizada.', {
      jobsInspected: recoveredJobs.length,
      statuses: recoveredJobs.map((job) => job.status),
    });
  } catch (error) {
    logger.error(
      'La reconciliacion inicial fallo. El cliente backend no se iniciara para evitar duplicados.',
      error,
    );
    tray.displayBalloon?.({
      title: 'Gestion al Dia Print Agent',
      content:
        'No fue posible reconciliar trabajos anteriores. Revisa el monitor antes de imprimir.',
    });
    reconciliationSucceeded = false;
  }

  if (isQuitting) {
    return;
  }

  if (reconciliationSucceeded) {
    backendPrintClient.start();
  }

  stopAutoUpdater?.();
  stopAutoUpdater = startAutoUpdater({
    logger,
    // Las notificaciones de updates se muestran en el balloon del tray cuando existe.
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

  app.on('before-quit', (event) => {
    if (shutdownCompleted) {
      return;
    }

    event.preventDefault();
    isQuitting = true;
    void shutdownRuntime().finally(() => {
      shutdownCompleted = true;
      app.quit();
    });
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

// Evita que una segunda instancia compita por el mismo puerto local. Si el usuario abre
// el agente de nuevo, se reutiliza la instancia activa y se recupera el servidor si hizo falta.
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

// Los errores globales no tumban de inmediato el proceso. Se registran y se intenta recuperar
// el servidor local, que es el componente critico para seguir imprimiendo.
process.on('uncaughtException', (error) => {
  loggerInstance?.error('Excepcion no controlada en el agente.', error);
  void restartLocalServer('uncaught-exception');
});

process.on('unhandledRejection', (reason) => {
  loggerInstance?.error('Promesa rechazada sin manejo en el agente.', reason);
  scheduleRestart('unhandled-rejection');
});

void bootstrap();

function shutdownRuntime(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  stopWatchdog();
  clearScheduledRestart();
  backendPrintClient?.stop();
  stopAutoUpdater?.();
  stopAutoUpdater = null;
  shutdownPromise = Promise.allSettled([
    localServer?.stop(),
    printTransportRegistry?.dispose(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        loggerInstance?.warn('Un recurso fallo durante el cierre del agente.', {
          error: result.reason,
        });
      }
    }
  });
  return shutdownPromise;
}

async function logPrintingRuntime(
  printerDiscoveryService: PrinterDiscoveryService,
  logger: LoggerService,
): Promise<void> {
  const moduleStatus = await printerDiscoveryService.getModuleStatus();
  logger.info('Runtime de impresion inicializado.', {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    arch: process.arch,
    printerModuleReady: moduleStatus.ready,
    printerModuleError: moduleStatus.error,
    printerModulePath: moduleStatus.runtime?.printerModulePath,
    printerBinaryPath: moduleStatus.runtime?.printerBinaryPath,
    printerPackageVersion: moduleStatus.runtime?.printerPackageVersion,
    printerModuleMode: moduleStatus.runtime?.printerModuleMode,
  });
}

/**
 * Garantiza que el servidor HTTP local este iniciado.
 *
 * Si aun no existe una instancia de LocalServer no hace nada. Si el arranque falla, registra
 * el error y programa un reinicio diferido para que el agente pueda recuperarse sin bloquear
 * el flujo de bootstrap o los handlers de Electron.
 */
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

/**
 * Reinicia el servidor HTTP local por una razon operacional conocida.
 *
 * Primero cancela cualquier reinicio pendiente para evitar duplicados, luego intenta detener
 * el servidor actual y volverlo a iniciar. Un fallo al detener no bloquea el intento de start,
 * porque el estado del servidor puede estar parcialmente caido. Si el start falla, agenda otro
 * reinicio automatico.
 */
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

/**
 * Agenda un unico reinicio automatico del servidor local.
 *
 * El temporizador funciona como debounce: multiples fallas cercanas comparten el mismo
 * reinicio pendiente. No agenda nada durante el cierre del agente.
 */
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

/**
 * Cancela un reinicio diferido si todavia no se ha ejecutado.
 *
 * Se usa antes de reinicios manuales, durante el cierre y antes de reintentos controlados para
 * mantener un solo camino de recuperacion activo.
 */
function clearScheduledRestart(): void {
  if (!restartTimer) {
    return;
  }

  clearTimeout(restartTimer);
  restartTimer = null;
}

/**
 * Inicia el watchdog que valida periodicamente que el servidor local siga escuchando.
 *
 * El watchdog no hace health checks HTTP; consulta el estado interno de LocalServer para
 * detectar si dejo de correr y, en ese caso, agenda la recuperacion automatica.
 */
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

/**
 * Detiene el watchdog y libera su intervalo.
 *
 * Es parte del apagado ordenado y tambien evita timers duplicados cuando bootstrap se ejecuta
 * mas de una vez sobre una instancia ya inicializada.
 */
function stopWatchdog(): void {
  if (!watchdogTimer) {
    return;
  }

  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
