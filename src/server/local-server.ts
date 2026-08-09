import http from 'node:http';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { shell } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrintHistoryService } from '../printing/history/print-history.service';
import { PrintOrchestratorService } from '../printing/print-orchestrator.service';
import { PrintDiagnosticsService } from '../printing/diagnostics/print-diagnostics.service';
import { PrinterDiscoveryService } from '../printing/printers/printer-discovery.service';
import { PrinterProfileService } from '../printing/printers/printer-profile.service';
import { PrinterQueueService } from '../printing/queue/printer-queue.service';
import {
  AgentHealthResponse,
  AgentMutationResponse,
  PrintJobsResponse,
  ReceiptJobPayload,
} from '../shared/contracts';
import {
  createCorsOptions,
  isAllowedAgentOrigin,
  isOfficialWebAgentOrigin,
  LOCAL_AGENT_ALLOWED_ORIGINS,
  OFFICIAL_WEB_ALLOWED_ORIGINS,
} from '../security/cors.config';
import { PairingTokenService } from '../security/pairing-token.service';
import { BackendPrintClientService } from '../backend/backend-print-client.service';
import { sanitizeAppConfig } from '../config/config.schema';
import { PrinterProfile } from '../printing/contracts/printer-profile';
import { PrintExecutionResultStatus } from '../printing/contracts/print-result';

const HOST = '127.0.0.1';
const PORT = 3088;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 30_000;
const SERVER_HEADERS_TIMEOUT_MS = 35_000;
const SERVER_REQUEST_TIMEOUT_MS = 970_000;
const REQUEST_HANDLER_TIMEOUT_MS = 90_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;

export interface LocalServerDependencies {
  version: string;
  startedAt: number;
  configService: AppConfigService;
  logger: LoggerService;
  queueService: PrinterQueueService;
  printerDiscoveryService: PrinterDiscoveryService;
  printerProfileService: PrinterProfileService;
  printOrchestrator: PrintOrchestratorService;
  printDiagnosticsService: PrintDiagnosticsService;
  printHistoryService: PrintHistoryService;
  pairingTokenService: PairingTokenService;
  backendPrintClient: BackendPrintClientService;
  onServerUnavailable?: (reason: 'server-error' | 'server-close', error?: unknown) => void;
}

export class LocalServer {
  private readonly app = express();
  private server: http.Server | null = null;
  private isStopping = false;

  constructor(private readonly dependencies: LocalServerDependencies) {
    this.configure();
  }

  isRunning(): boolean {
    return this.server?.listening === true;
  }

  getBaseUrl(): string {
    return `http://${HOST}:${PORT}/`;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }

    this.isStopping = false;

    await new Promise<void>((resolve, reject) => {
      const nextServer = this.app.listen(PORT, HOST);
      const cleanup = () => {
        nextServer.off('listening', handleListening);
        nextServer.off('error', handleError);
      };
      const handleListening = () => {
        cleanup();
        this.server = nextServer;
        this.attachLifecycleHandlers(nextServer);
        this.dependencies.logger.info('Servidor local iniciado.', {
          host: HOST,
          port: PORT,
        });
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        this.server = null;
        this.dependencies.logger.error('No fue posible iniciar el servidor local.', error);
        reject(error);
      };

      nextServer.once('listening', handleListening);
      nextServer.once('error', handleError);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const currentServer = this.server;
    this.server = null;
    this.isStopping = true;

    try {
      await new Promise<void>((resolve, reject) => {
        let isSettled = false;
        const finish = (callback: () => void) => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          clearTimeout(timeoutId);
          callback();
        };
        const timeoutId = setTimeout(() => {
          this.dependencies.logger.warn(
            'El servidor local tardo demasiado en cerrar. Se forzaran las conexiones activas.',
          );
          currentServer.closeAllConnections?.();
          finish(resolve);
        }, SERVER_STOP_TIMEOUT_MS);

        currentServer.close((error) => {
          if (error) {
            finish(() => reject(error));
            return;
          }

          finish(resolve);
        });
      });
    } finally {
      this.isStopping = false;
    }
  }

  private configure(): void {
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '3mb' }));
    this.app.use((request, response, next) => {
      const origin = request.header('origin');
      const isPrivateNetworkPreflight =
        request.header('access-control-request-private-network')?.toLowerCase() === 'true';

      if (origin) {
        response.vary('Origin');
      }

      if (origin && !isAllowedAgentOrigin(origin)) {
        this.dependencies.logger.warn('Solicitud local bloqueada por CORS.', {
          origin,
          method: request.method,
          path: request.originalUrl,
          userAgent: request.header('user-agent') ?? 'unknown',
        });
      }

      if (isPrivateNetworkPreflight && origin && isOfficialWebAgentOrigin(origin)) {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.vary('Access-Control-Request-Private-Network');
      }

      next();
    });
    this.app.use(cors(createCorsOptions()));
    this.app.use((request, response, next) => {
      const config = this.dependencies.configService.getConfig();
      const requestTimeoutMs = isPrintExecutionRequest(request)
        ? config.printJobCompletionTimeoutMs * 5 + 60_000
        : REQUEST_HANDLER_TIMEOUT_MS;
      response.setTimeout(requestTimeoutMs, () => {
        if (response.headersSent) {
          return;
        }

        this.dependencies.logger.warn('La peticion local excedio el tiempo maximo.', {
          method: request.method,
          path: request.originalUrl,
        });
        response.status(504).json({
          success: false,
          message:
            'El agente local tardo demasiado en procesar la solicitud. Vuelve a intentar.',
        });
      });
      next();
    });

    this.app.get('/health', async (_request, response) => {
      const config = this.dependencies.configService.getConfig();
      const printerModuleStatus = await this.dependencies.printerDiscoveryService.getModuleStatus();
      const backendRuntimeStatus = this.dependencies.backendPrintClient.getStatusSnapshot();
      const payload: AgentHealthResponse = {
        status: 'ok',
        app: 'Gestion Al Dia Print Agent',
        version: this.dependencies.version,
        platform: process.platform,
        pairingRequired: config.pairingToken !== null,
        configured: Boolean(config.invoicePrinterName || config.kitchenPrinterName),
        printerModuleReady: printerModuleStatus.ready,
        printerModuleError: printerModuleStatus.error,
        backend: {
          linked: Boolean(config.backendDeviceToken),
          baseUrl: config.backendBaseUrl,
          agentId: config.backendAgentId,
          businessId: config.backendBusinessId,
          connected: backendRuntimeStatus.connected,
          lastContactAt: backendRuntimeStatus.lastContactAt,
          lastDisconnectReason: backendRuntimeStatus.lastDisconnectReason,
          lastError: backendRuntimeStatus.lastError,
        },
        uptimeSeconds: Math.max(
          0,
          Math.floor((Date.now() - this.dependencies.startedAt) / 1000),
        ),
        queue: this.dependencies.queueService.getSnapshot(),
      };

      response.json(payload);
    });

    this.app.get('/monitor', (_request, response) => {
      response.type('html').send(buildMonitorPage());
    });

    this.app.use((request, response, next) => this.requireAuthorizedRequest(request, response, next));

    this.app.get('/printers', async (_request, response, next) => {
      try {
        response.json({
          printers: await this.dependencies.printerDiscoveryService.listPrinters(),
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.get('/config', (_request, response) => {
      response.json({
        config: this.dependencies.configService.getConfig(),
      });
    });

    this.app.get('/jobs', (_request, response) => {
      const payload: PrintJobsResponse = {
        jobs: this.dependencies.printHistoryService.getRecentJobs(),
      };
      response.json(payload);
    });

    this.app.get('/printing/status', async (_request, response, next) => {
      try {
        response.json(await this.dependencies.printDiagnosticsService.getOverview());
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/config', (request, response, next) => {
      try {
        const currentConfig = this.dependencies.configService.getConfig();
        const candidateConfig = {
          ...currentConfig,
          ...request.body,
          invoicePrinterName: normalizeNullableString(request.body?.invoicePrinterName, currentConfig.invoicePrinterName),
          kitchenPrinterName: normalizeNullableString(request.body?.kitchenPrinterName, currentConfig.kitchenPrinterName),
          pairingToken: normalizeNullableString(request.body?.pairingToken, currentConfig.pairingToken),
          allowedOrigins: Array.isArray(request.body?.allowedOrigins)
            ? request.body.allowedOrigins
            : currentConfig.allowedOrigins,
        };
        const nextConfig = sanitizeAppConfig(candidateConfig);
        response.json({
          success: true,
          message: 'Configuracion local actualizada.',
          config: this.dependencies.configService.saveConfig(nextConfig),
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/config/reveal', async (_request, response, next) => {
      try {
        await shell.showItemInFolder(this.dependencies.configService.getConfigPath());
        this.sendSuccess(response, 'Se abrio la carpeta de configuracion del agente.');
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/backend/register', async (request, response, next) => {
      try {
        const pairingCode = normalizeNullableString(request.body?.pairingCode, null);

        if (!pairingCode) {
          throw new Error('Ingresa el codigo de vinculacion generado en Gestion al Dia.');
        }

        const registration = await this.dependencies.backendPrintClient.register(pairingCode);

        response.json({
          success: true,
          message: 'Agente vinculado con el backend de Gestion al Dia.',
          registration,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/backend/sync-printers', async (_request, response, next) => {
      try {
        const result = await this.dependencies.backendPrintClient.syncPrintersNow();

        response.json({
          success: true,
          message: `Se sincronizaron ${result.synced} impresora(s) con Gestion al Dia.`,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/printers/profile', (request, response, next) => {
      try {
        const requestedProfile = request.body as Partial<PrinterProfile>;
        const systemName = requireBodyPrinterName(requestedProfile?.systemName);
        const currentProfile = this.dependencies.printerProfileService.resolveProfile(
          systemName,
        );
        const profile = this.dependencies.printerProfileService.saveProfile(
          {
            ...currentProfile,
            ...requestedProfile,
            systemName,
            raw: {
              ...currentProfile.raw,
              ...requestedProfile.raw,
            },
            driver: {
              ...currentProfile.driver,
              ...requestedProfile.driver,
              usePrinterDefaultPageSize:
                requestedProfile.driver?.usePrinterDefaultPageSize ??
                currentProfile.driver?.usePrinterDefaultPageSize ??
                true,
            },
          },
        );
        response.json({
          success: true,
          message: `Perfil de ${profile.systemName} actualizado.`,
          profile,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/printers/unblock', (request, response, next) => {
      try {
        const printerName = requireBodyPrinterName(request.body?.printerName);
        this.dependencies.printOrchestrator.unblockPrinter(printerName);
        this.sendSuccess(
          response,
          `La impresora ${printerName} fue desbloqueada conscientemente.`,
        );
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/diagnostics/raw-minimal', async (request, response, next) => {
      try {
        const printerName = requireBodyPrinterName(request.body?.printerName);
        const result = await this.dependencies.printDiagnosticsService.runRawMinimal(
          printerName,
        );
        response.json({ success: result.status === 'SPOOL_COMPLETED', result });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/diagnostics/raw-full', async (request, response, next) => {
      try {
        const printerName = requireBodyPrinterName(request.body?.printerName);
        const result = await this.dependencies.printDiagnosticsService.runRawFull(
          printerName,
        );
        response.json({ success: result.status === 'SPOOL_COMPLETED', result });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/diagnostics/driver', async (request, response, next) => {
      try {
        const printerName = requireBodyPrinterName(request.body?.printerName);
        const result = await this.dependencies.printDiagnosticsService.runDriver(
          printerName,
        );
        response.json({ success: result.status === 'SPOOL_COMPLETED', result });
      } catch (error) {
        next(error);
      }
    });

    this.app.get('/printing/diagnostics/export', async (request, response, next) => {
      try {
        const printerName = requireBodyPrinterName(request.query.printerName);
        response.json(
          await this.dependencies.printDiagnosticsService.exportDiagnostic(printerName),
        );
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/jobs/:localJobId/cancel', async (request, response, next) => {
      try {
        const job = await this.dependencies.printOrchestrator.cancelJob(
          request.params.localJobId,
        );
        response.json({
          success: true,
          message: `El trabajo ${job.localJobId} fue cancelado y eliminado de Windows.`,
          job,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/printing/jobs/:localJobId/refresh', async (request, response, next) => {
      try {
        const job = await this.dependencies.printOrchestrator.refreshJobStatus(
          request.params.localJobId,
        );
        response.json({
          success: true,
          message: `Estado de ${job.localJobId} consultado en Windows.`,
          job,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/test', async (_request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        const payload = buildTestPayload(config.paperWidth);
        const printerName = resolveConfiguredPrinter(config.invoicePrinterName, 'facturas');
        const result = await this.dependencies.printOrchestrator.execute({
          source: 'LOCAL',
          jobType: 'RECEIPT',
          payload,
          printerName,
          documentName: 'factura-prueba-local',
          copies: 1,
          paperWidth: config.paperWidth,
        });
        response.json({
          success: result.status === 'SPOOL_COMPLETED',
          message: describePrintResult('Factura de prueba', result.status),
          result,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/invoice', async (request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        if (!config.invoiceEnabled) {
          throw new Error('La impresion de facturas esta desactivada en este equipo.');
        }

        const payload = request.body as ReceiptJobPayload;
        const copies = payload.options?.copies ?? config.invoiceCopies;
        const printerName = resolveConfiguredPrinter(config.invoicePrinterName, 'facturas');
        const result = await this.dependencies.printOrchestrator.execute({
          source: 'LOCAL',
          jobType: 'RECEIPT',
          payload,
          printerName,
          documentName: 'factura',
          copies,
          paperWidth: payload.options?.paperWidth ?? config.paperWidth,
        });
        response.json({
          success: result.status === 'SPOOL_COMPLETED',
          message: describePrintResult('Factura', result.status),
          result,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/kitchen-order', async (request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        if (!config.kitchenEnabled) {
          throw new Error('La impresion de comandas esta desactivada en este equipo.');
        }

        const payload = request.body as ReceiptJobPayload;
        const copies = payload.options?.copies ?? config.kitchenCopies;
        const printerName = resolveConfiguredPrinter(config.kitchenPrinterName, 'cocina');
        const result = await this.dependencies.printOrchestrator.execute({
          source: 'LOCAL',
          jobType: 'KITCHEN_TICKET',
          payload,
          printerName,
          documentName: 'comanda-cocina',
          copies,
          paperWidth: payload.options?.paperWidth ?? config.paperWidth,
        });
        response.json({
          success: result.status === 'SPOOL_COMPLETED',
          message: describePrintResult('Comanda', result.status),
          result,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.use(
      (
        error: unknown,
        _request: Request,
        response: Response<AgentMutationResponse>,
        _next: NextFunction,
      ) => {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : 'Ocurrio un error inesperado en el agente local.';
        this.dependencies.logger.error('Error en el servidor local.', error);
        response.status(400).json({
          success: false,
          message,
        });
      },
    );
  }

  private requireAuthorizedRequest(
    request: Request,
    response: Response<AgentMutationResponse>,
    next: NextFunction,
  ): void {
    const expectedToken = this.dependencies.configService.getConfig().pairingToken;

    if (!expectedToken) {
      next();
      return;
    }

    const authorizationHeader = request.header('authorization');
    const bearerToken =
      authorizationHeader?.toLowerCase().startsWith('bearer ') === true
        ? authorizationHeader.slice(7).trim()
        : null;
    const token =
      request.header('x-gestion-print-token')?.trim() ??
      request.header('x-gad-print-token')?.trim() ??
      bearerToken;

    if (this.dependencies.pairingTokenService.matches(expectedToken, token ?? null)) {
      next();
      return;
    }

    if (isTrustedRecoveryRequest(request, this.dependencies.configService)) {
      next();
      return;
    }

    response.status(401).json({
      success: false,
      message: 'Token local invalido. Vuelve a emparejar el agente con Gestion al Dia.',
    });
  }

  private sendSuccess(response: Response<AgentMutationResponse>, message: string): void {
    response.json({
      success: true,
      message,
    });
  }

  private attachLifecycleHandlers(server: http.Server): void {
    server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;

    server.on('error', (error: Error) => {
      this.dependencies.logger.error('Error del servidor local.', error);

      if (this.server === server && !this.isStopping) {
        this.dependencies.onServerUnavailable?.('server-error', error);
      }
    });

    server.on('close', () => {
      const wasActiveServer = this.server === server;
      const wasUnexpectedClose = wasActiveServer && !this.isStopping;

      if (wasActiveServer) {
        this.server = null;
      }

      this.dependencies.logger.warn('El servidor local se cerro.', {
        unexpected: wasUnexpectedClose,
      });

      if (wasUnexpectedClose) {
        this.dependencies.onServerUnavailable?.('server-close');
      }
    });
  }
}

function buildTestPayload(paperWidth: '58mm' | '80mm'): ReceiptJobPayload {
  return {
    title: 'FACTURA DE PRUEBA',
    business: {
      name: 'Gestion al Dia',
      nit: '900123456-7',
      address: 'Calle 123 #45-67',
      phone: '+57 300 123 4567',
    },
    order: {
      id: 'TEST-001',
      createdAt: new Date().toLocaleString('es-CO'),
      tableName: 'Mesa 1',
      waiterName: 'Sistema',
    },
    items: [
      {
        name: 'Validacion de impresion',
        quantity: 1,
        unitPrice: 0,
        total: 0,
        notes: 'Ticket generado desde el agente local',
      },
    ],
    totals: {
      subtotal: 0,
      tax: 0,
      discount: 0,
      total: 0,
      paid: 0,
      change: 0,
    },
    options: {
      copies: 1,
      cutPaper: true,
      openCashDrawer: false,
      paperWidth,
    },
  };
}

function resolveConfiguredPrinter(
  printerName: string | null,
  purpose: string,
): string {
  if (!printerName?.trim()) {
    throw new Error(`No hay una impresora configurada para ${purpose}.`);
  }

  return printerName.trim();
}

function requireBodyPrinterName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('El system name de la impresora es obligatorio.');
  }

  return value.trim();
}

function describePrintResult(
  subject: string,
  status: PrintExecutionResultStatus,
): string {
  switch (status) {
    case 'SPOOL_COMPLETED':
      return `${subject}: Windows dejo de tener el trabajo pendiente sin reportar error.`;
    case 'FAILED':
      return `${subject}: el trabajo fallo antes de completar el ciclo del spooler.`;
    case 'STUCK':
      return `${subject}: el trabajo quedo atascado y la impresora fue bloqueada para evitar duplicados.`;
    case 'CANCELLED':
      return `${subject}: el trabajo fue cancelado.`;
    case 'PARTIAL_FAILURE':
      return `${subject}: algunas copias completaron y otras no. No se reintentaran automaticamente.`;
    default:
      return `${subject}: Windows acepto el trabajo, pero el resultado final no pudo confirmarse.`;
  }
}

function normalizeNullableString(value: unknown, fallback: string | null): string | null {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
}

function isPrintExecutionRequest(request: Request): boolean {
  return (
    request.method === 'POST' &&
    (request.path.startsWith('/print/') ||
      request.path.startsWith('/printing/diagnostics/'))
  );
}

function isTrustedRecoveryRequest(
  request: Request,
  configService: AppConfigService,
): boolean {
  if (request.path === '/backend/register') {
    return (
      request.method === 'POST' &&
      isLoopbackAddress(request.socket.remoteAddress) &&
      (isLocalAgentOrigin(request.header('origin')) ||
        isLocalAgentOrigin(request.header('referer')))
    );
  }

  if (request.path === '/backend/sync-printers') {
    return (
      request.method === 'POST' &&
      isLoopbackAddress(request.socket.remoteAddress) &&
      isTrustedBrowserOrigin(request.header('origin'))
    );
  }

  if (request.method !== 'GET') {
    const localOperationalPath =
      request.path === '/print/test' ||
      request.path.startsWith('/printing/diagnostics/') ||
      request.path.startsWith('/printing/jobs/') ||
      request.path === '/printing/printers/profile' ||
      request.path === '/printing/printers/unblock';

    return (
      localOperationalPath &&
      isLoopbackAddress(request.socket.remoteAddress) &&
      (isLocalAgentOrigin(request.header('origin')) ||
        isLocalAgentOrigin(request.header('referer')))
    );
  }

  if (
    request.path === '/config' ||
    request.path === '/printers'
  ) {
    const origin = request.header('origin');
    return Boolean(origin && isTrustedBrowserOrigin(origin));
  }

  if (request.path !== '/jobs' && request.path !== '/printing/status') {
    return false;
  }

  return isLoopbackAddress(request.socket.remoteAddress);
}

function isTrustedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }

  return (
    LOCAL_AGENT_ALLOWED_ORIGINS.has(origin) || OFFICIAL_WEB_ALLOWED_ORIGINS.has(origin)
  );
}

function isLocalAgentOrigin(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).origin === `http://${HOST}:${PORT}`;
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1'
  );
}

function buildMonitorPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gestion al Dia Print Agent</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef3f8;
        --surface: #ffffff;
        --surface-soft: #f7fafe;
        --border: #d8e3f0;
        --text: #16324f;
        --muted: #5c728a;
        --accent: #1f78ff;
        --ok: #138a52;
        --warn: #b7791f;
        --error: #c0392b;
        --shadow: 0 20px 50px rgba(15, 35, 60, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }

      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 24px 40px;
      }

      .hero {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 24px;
      }

      .hero h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }

      .hero p {
        margin: 0;
        color: var(--muted);
        max-width: 680px;
        line-height: 1.5;
      }

      .hero-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        flex-wrap: wrap;
      }

      .test-print-feedback {
        margin: -8px 0 24px;
        white-space: pre-wrap;
      }

      .refresh-pill {
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.82);
        color: var(--muted);
        border-radius: 6px;
        padding: 10px 14px;
        font-size: 13px;
        white-space: nowrap;
        box-shadow: var(--shadow);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }

      .card {
        background: rgba(255, 255, 255, 0.88);
        border: 1px solid rgba(216, 227, 240, 0.88);
        border-radius: 8px;
        padding: 18px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(8px);
      }

      .card span {
        display: block;
        font-size: 13px;
        color: var(--muted);
        margin-bottom: 10px;
      }

      .card strong {
        font-size: 24px;
      }

      .panel {
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(216, 227, 240, 0.9);
        border-radius: 8px;
        box-shadow: var(--shadow);
        overflow: hidden;
        margin-bottom: 24px;
      }

      .panel__head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 20px 22px;
        background: var(--surface-soft);
        border-bottom: 1px solid var(--border);
      }

      .panel__head h2 {
        margin: 0 0 4px;
        font-size: 20px;
      }

      .panel__head p {
        margin: 0;
        color: var(--muted);
      }

      .collapsible-panel > summary {
        list-style: none;
        cursor: pointer;
        user-select: none;
      }

      .collapsible-panel > summary::-webkit-details-marker {
        display: none;
      }

      .collapsible-panel:not([open]) > summary {
        border-bottom: 0;
      }

      .summary-status {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .collapse-indicator {
        width: 10px;
        height: 10px;
        border-right: 2px solid var(--muted);
        border-bottom: 2px solid var(--muted);
        transform: rotate(45deg) translateY(-2px);
        transition: transform 160ms ease;
      }

      .collapsible-panel[open] .collapse-indicator {
        transform: rotate(225deg) translate(-2px, -2px);
      }

      .panel__body {
        padding: 22px;
      }

      .panel__body--split {
        display: grid;
        grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.15fr);
        gap: 20px;
        align-items: start;
      }

      .status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .status--queued,
      .status--formatting,
      .status--ready,
      .status--submitting,
      .status--submitted,
      .status--spooling,
      .status--printing,
      .status--unknown,
      .status--stuck,
      .status--blocked {
        color: var(--warn);
        background: rgba(183, 121, 31, 0.12);
      }

      .status--completed,
      .status--spool_completed,
      .status--healthy {
        color: var(--ok);
        background: rgba(19, 138, 82, 0.12);
      }

      .status--failed,
      .status--cancelled,
      .status--degraded {
        color: var(--error);
        background: rgba(192, 57, 43, 0.12);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        text-align: left;
        padding: 16px 22px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }

      th {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted);
      }

      td {
        font-size: 14px;
      }

      tbody tr:hover {
        background: var(--surface-soft);
      }

      .empty {
        padding: 28px 22px 34px;
        color: var(--muted);
      }

      .job-label {
        font-weight: 700;
      }

      .job-meta {
        display: block;
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }

      .error-text {
        color: var(--error);
        line-height: 1.45;
      }

      .backend-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }

      .meta-item {
        padding: 16px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--surface-soft);
      }

      .meta-item span {
        display: block;
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .meta-item strong {
        display: block;
        font-size: 14px;
        line-height: 1.45;
        word-break: break-word;
      }

      .form-stack {
        display: grid;
        gap: 14px;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      .field span {
        font-size: 13px;
        font-weight: 700;
      }

      .field input {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 12px 14px;
        font: inherit;
        color: var(--text);
        background: #fff;
      }

      .field input:focus {
        outline: 2px solid rgba(31, 120, 255, 0.16);
        border-color: var(--accent);
      }

      .form-actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }

      .button {
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 9px 12px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .button--primary {
        background: var(--accent);
        color: #fff;
        box-shadow: var(--shadow);
      }

      .button--secondary {
        border-color: var(--border);
        background: var(--surface);
        color: var(--text);
      }

      .button--danger {
        border-color: rgba(192, 57, 43, 0.35);
        background: #fff;
        color: var(--error);
      }

      .printer-list {
        display: grid;
      }

      .printer-row {
        padding: 18px 22px;
        border-bottom: 1px solid var(--border);
      }

      .printer-row:last-child {
        border-bottom: 0;
      }

      .printer-title,
      .printer-actions,
      .profile-control {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .printer-title {
        justify-content: space-between;
        margin-bottom: 14px;
      }

      .printer-title h3 {
        margin: 0;
        font-size: 17px;
      }

      .printer-data {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px 18px;
        margin-bottom: 14px;
      }

      .printer-data dt {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .printer-data dd {
        margin: 5px 0 0;
        font-size: 13px;
        overflow-wrap: anywhere;
      }

      .profile-control select {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
        background: #fff;
        color: var(--text);
      }

      .button:disabled {
        opacity: 0.7;
        cursor: wait;
      }

      .form-help {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
        font-size: 13px;
      }

      .notice {
        border-radius: 8px;
        padding: 14px 16px;
        line-height: 1.5;
        font-size: 14px;
      }

      .notice--ok {
        color: var(--ok);
        border: 1px solid rgba(19, 138, 82, 0.2);
        background: rgba(19, 138, 82, 0.12);
      }

      .notice--error {
        color: var(--error);
        border: 1px solid rgba(192, 57, 43, 0.18);
        background: rgba(192, 57, 43, 0.1);
      }

      @media (max-width: 760px) {
        main {
          padding: 20px 14px 32px;
        }

        .hero,
        .panel__head {
          flex-direction: column;
          align-items: flex-start;
        }

        .hero-actions {
          justify-content: flex-start;
        }

        .collapsible-panel > .panel__head {
          flex-direction: row;
          align-items: center;
        }

        .panel__body--split {
          grid-template-columns: 1fr;
        }

        th:nth-child(4),
        td:nth-child(4) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <h1>Monitor y configuracion del agente de impresion</h1>
          <p>
            Consulta el estado de impresion de este equipo, sus impresoras configuradas y los
            trabajos recientes.
          </p>
        </div>
        <div class="hero-actions">
          <button id="test-print-button" class="button button--primary" type="button">
            Probar impresion
          </button>
          <div id="last-refresh" class="refresh-pill">Actualizando...</div>
        </div>
      </section>

      <div id="test-print-feedback" class="notice test-print-feedback" hidden></div>

      <section class="grid">
        <article class="card">
          <span>Estado del servicio</span>
          <strong id="service-status">Verificando...</strong>
        </article>
        <article class="card">
          <span>Trabajos pendientes</span>
          <strong id="pending-jobs">0</strong>
        </article>
        <article class="card">
          <span>Trabajo activo</span>
          <strong id="active-job">Sin trabajo</strong>
        </article>
        <article class="card">
          <span>Tiempo activo</span>
          <strong id="uptime">0 s</strong>
        </article>
        <article class="card">
          <span>Vinculacion</span>
          <strong id="backend-link">Sin vincular</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel__head">
          <div>
            <h2>Estado de impresoras</h2>
            <p>Estado local, transporte configurado y ultimo trabajo observado en Windows.</p>
          </div>
        </div>
        <div id="printer-container" class="printer-list">
          <div class="empty">Consultando impresoras...</div>
        </div>
      </section>

      <details class="panel collapsible-panel">
        <summary class="panel__head">
          <div>
            <h2>Vinculacion con Gestion al Dia</h2>
          </div>
          <div class="summary-status">
            <span id="backend-status" class="status status--queued">Sin vincular</span>
            <span class="collapse-indicator" aria-hidden="true"></span>
          </div>
        </summary>
        <div class="panel__body panel__body--split">
          <div class="backend-meta">
            <article class="meta-item">
              <span>Estado actual</span>
              <strong id="backend-status-detail">Pendiente de vinculacion</strong>
            </article>
            <article class="meta-item">
              <span>Ultimo contacto</span>
              <strong id="backend-last-contact">Sin datos</strong>
            </article>
            <article class="meta-item">
              <span>Ultimo error backend</span>
              <strong id="backend-last-error">Sin errores registrados</strong>
            </article>
          </div>

          <form id="backend-register-form" class="form-stack">
            <label class="field">
              <span>Codigo de vinculacion</span>
              <input
                id="pairing-code"
                name="pairingCode"
                inputmode="numeric"
                autocomplete="one-time-code"
                placeholder="Ej. 123456"
                maxlength="12"
                required
              />
            </label>

            <div class="form-actions">
              <button id="backend-register-submit" class="button button--primary" type="submit">
                Vincular agente
              </button>
            </div>

            <div id="backend-register-feedback" class="notice" hidden></div>
          </form>
        </div>
      </details>

      <section class="panel">
        <div class="panel__head">
          <div>
            <h2>Historial reciente</h2>
            <p>Se conservan los ultimos 200 trabajos. Esta vista muestra los mas recientes.</p>
          </div>
          <button id="manual-refresh" class="refresh-pill" type="button">Actualizar ahora</button>
        </div>
        <div id="table-container"></div>
      </section>
    </main>

    <script>
      const lastRefreshNode = document.getElementById('last-refresh');
      const serviceStatusNode = document.getElementById('service-status');
      const pendingJobsNode = document.getElementById('pending-jobs');
      const activeJobNode = document.getElementById('active-job');
      const uptimeNode = document.getElementById('uptime');
      const backendLinkNode = document.getElementById('backend-link');
      const backendStatusNode = document.getElementById('backend-status');
      const backendStatusDetailNode = document.getElementById('backend-status-detail');
      const backendLastContactNode = document.getElementById('backend-last-contact');
      const backendLastErrorNode = document.getElementById('backend-last-error');
      const backendRegisterForm = document.getElementById('backend-register-form');
      const pairingCodeInput = document.getElementById('pairing-code');
      const backendRegisterSubmit = document.getElementById('backend-register-submit');
      const backendRegisterFeedback = document.getElementById('backend-register-feedback');
      const tableContainerNode = document.getElementById('table-container');
      const printerContainerNode = document.getElementById('printer-container');
      const manualRefreshButton = document.getElementById('manual-refresh');
      const testPrintButton = document.getElementById('test-print-button');
      const testPrintFeedback = document.getElementById('test-print-feedback');

      function formatDate(value) {
        try {
          return new Intl.DateTimeFormat('es-CO', {
            dateStyle: 'short',
            timeStyle: 'medium',
          }).format(new Date(value));
        } catch {
          return value;
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function renderBackendStatus(health) {
        const backend = health && health.backend
          ? health.backend
          : {
              linked: false,
              connected: false,
              lastContactAt: null,
              lastDisconnectReason: null,
              lastError: null,
            };
        const linked = backend.linked === true;
        const connected = backend.connected === true;
        const hasError = Boolean(backend.lastError && backend.lastError.message);

        backendLinkNode.textContent = !linked
          ? 'Sin vincular'
          : connected
            ? 'Conectado'
            : 'Desconectado';
        backendStatusNode.textContent = !linked
          ? 'Sin vincular'
          : connected
            ? 'Conectado'
            : hasError
              ? 'Con error'
              : 'Desconectado';
        backendStatusNode.className =
          'status ' +
          (!linked
            ? 'status--queued'
            : connected
              ? 'status--completed'
              : 'status--failed');
        backendStatusDetailNode.textContent = !linked
          ? 'Ingresa el codigo temporal para registrar este equipo.'
          : connected
            ? 'El agente esta conectado y puede recibir trabajos.'
            : backend.lastDisconnectReason
              ? 'Ultima desconexion: ' + backend.lastDisconnectReason
              : 'El agente esta vinculado, pero no tiene una conexion activa.';
        backendLastContactNode.textContent = backend.lastContactAt
          ? formatDate(backend.lastContactAt)
          : 'Sin datos';
        backendLastErrorNode.textContent = backend.lastError && backend.lastError.message
          ? backend.lastError.message + (backend.lastError.at ? ' (' + formatDate(backend.lastError.at) + ')' : '')
          : 'Sin errores registrados';
      }

      function clearBackendFeedback() {
        backendRegisterFeedback.hidden = true;
        backendRegisterFeedback.textContent = '';
        backendRegisterFeedback.className = 'notice';
      }

      function showBackendFeedback(message, variant) {
        backendRegisterFeedback.hidden = false;
        backendRegisterFeedback.textContent = message;
        backendRegisterFeedback.className =
          'notice ' + (variant === 'ok' ? 'notice--ok' : 'notice--error');
      }

      function showTestPrintFeedback(message, variant) {
        testPrintFeedback.hidden = false;
        testPrintFeedback.textContent = message;
        testPrintFeedback.className =
          'notice test-print-feedback ' +
          (variant === 'ok' ? 'notice--ok' : 'notice--error');
      }

      function formatTestPrintFeedback(payload) {
        const result = payload && payload.result ? payload.result : null;
        const lines = [payload && payload.message ? payload.message : 'La prueba finalizo.'];

        if (!result) {
          return lines.join('\\n');
        }

        lines.push('Estado: ' + String(result.status || 'UNKNOWN'));
        lines.push('Impresora: ' + String(result.printerName || 'Sin datos'));
        lines.push('Transporte: ' + String(result.transport || 'Sin datos'));

        const attempts = Array.isArray(result.attempts) ? result.attempts : [];
        attempts.forEach((attempt) => {
          const details = [
            'Copia ' + String(attempt.copyNumber || 1) + ': ' + String(attempt.status || 'UNKNOWN'),
            'Trabajo local: ' + String(attempt.localJobId || 'Sin datos'),
            'Windows JobId: ' + String(attempt.systemJobId ?? 'No disponible'),
          ];

          if (Array.isArray(attempt.lastWindowsStatus) && attempt.lastWindowsStatus.length > 0) {
            details.push('Windows: ' + attempt.lastWindowsStatus.join(', '));
          }
          if (attempt.errorCode) {
            details.push('Codigo: ' + String(attempt.errorCode));
          }
          if (attempt.errorMessage) {
            details.push('Error: ' + String(attempt.errorMessage));
          }

          lines.push(details.join(' | '));
        });

        return lines.join('\\n');
      }

      function renderJobs(jobs) {
        if (!Array.isArray(jobs) || jobs.length === 0) {
          tableContainerNode.innerHTML =
            '<div class="empty">Todavia no se han registrado trabajos de impresion.</div>';
          return;
        }

        const rows = jobs
          .map((job) => {
            const errorHtml = job.errorMessage
              ? '<div class="error-text">' + escapeHtml(job.errorMessage) + '</div>'
              : '<span class="job-meta">Sin errores registrados</span>';

            return \`
              <tr>
                <td>
                  <div class="job-label">\${escapeHtml(job.documentName || job.jobType)}</div>
                  <span class="job-meta">Local: \${escapeHtml(job.localJobId)}</span>
                  <span class="job-meta">Backend: \${escapeHtml(job.backendJobId || 'Local')}</span>
                </td>
                <td>\${escapeHtml(job.printerName)}</td>
                <td>
                  <span class="status status--\${escapeHtml(String(job.status).toLowerCase())}">\${escapeHtml(job.status)}</span>
                  <span class="job-meta">Windows JobId: \${escapeHtml(job.windowsJobId ?? 'No disponible')}</span>
                </td>
                <td>\${escapeHtml(formatDate(job.updatedAt))}</td>
                <td>\${errorHtml}</td>
              </tr>
            \`;
          })
          .join('');

        tableContainerNode.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Trabajo</th>
                <th>Impresora</th>
                <th>Resultado</th>
                <th>Actualizado</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>\${rows}</tbody>
          </table>
        \`;
      }

      function renderPrinters(payload) {
        const printers = payload && Array.isArray(payload.printers) ? payload.printers : [];

        if (printers.length === 0) {
          printerContainerNode.innerHTML = '<div class="empty">Windows no reporto impresoras instaladas.</div>';
          return;
        }

        printerContainerNode.innerHTML = printers.map((printer) => {
          const lastJob = printer.lastJob || {};
          const canQuery = Boolean(lastJob.localJobId && lastJob.windowsJobId);
          const canCancel = canQuery && ['SUBMITTED', 'SPOOLING', 'PRINTING', 'STUCK', 'UNKNOWN'].includes(lastJob.status);
          const duration = typeof lastJob.elapsedMs === 'number'
            ? (lastJob.elapsedMs / 1000).toFixed(1) + ' s'
            : 'Sin datos';
          const windowsStatus = Array.isArray(lastJob.lastWindowsStatus) && lastJob.lastWindowsStatus.length
            ? lastJob.lastWindowsStatus.join(', ')
            : 'Sin datos';

          return \`
            <article class="printer-row" data-printer="\${escapeHtml(printer.systemName)}" data-paper-width="\${escapeHtml(printer.paperWidth)}">
              <div class="printer-title">
                <h3>\${escapeHtml(printer.name)}</h3>
                <span class="status status--\${escapeHtml(String(printer.agentStatus).toLowerCase())}">\${escapeHtml(printer.agentStatus)}</span>
              </div>
              <dl class="printer-data">
                <div><dt>System name</dt><dd>\${escapeHtml(printer.systemName)}</dd></div>
                <div><dt>Transporte</dt><dd>\${escapeHtml(printer.transport)}</dd></div>
                <div><dt>Cola local</dt><dd>\${escapeHtml(printer.queue?.pendingJobs ?? 0)}</dd></div>
                <div><dt>Ultimo backend job</dt><dd>\${escapeHtml(lastJob.backendJobId || 'Local / sin datos')}</dd></div>
                <div><dt>Windows JobId</dt><dd>\${escapeHtml(lastJob.windowsJobId ?? 'No disponible')}</dd></div>
                <div><dt>Windows status</dt><dd>\${escapeHtml(windowsStatus)}</dd></div>
                <div><dt>Duracion</dt><dd>\${escapeHtml(duration)}</dd></div>
                <div><dt>Ultimo error</dt><dd class="\${lastJob.errorMessage ? 'error-text' : ''}">\${escapeHtml(lastJob.errorMessage || printer.queue?.blockReason || 'Sin errores')}</dd></div>
              </dl>
              <div class="printer-actions">
                <button class="button button--secondary" data-action="raw-minimal" type="button">Prueba RAW minima</button>
                <button class="button button--secondary" data-action="driver" type="button">Prueba driver</button>
                \${canQuery ? '<button class="button button--secondary" data-action="refresh-job" data-job-id="' + escapeHtml(lastJob.localJobId) + '" type="button">Consultar estado</button>' : ''}
                \${canCancel ? '<button class="button button--danger" data-action="cancel" data-job-id="' + escapeHtml(lastJob.localJobId) + '" type="button">Cancelar este trabajo</button>' : ''}
                \${printer.agentStatus === 'BLOCKED' ? '<button class="button button--secondary" data-action="unblock" type="button">Desbloquear</button>' : ''}
              </div>
              <div class="profile-control">
                <label class="field">
                  <span>Transporte configurado</span>
                  <select data-role="transport">
                    <option value="WINDOWS_RAW" \${printer.transport === 'WINDOWS_RAW' ? 'selected' : ''}>WINDOWS_RAW</option>
                    <option value="WINDOWS_DRIVER" \${printer.transport === 'WINDOWS_DRIVER' ? 'selected' : ''}>WINDOWS_DRIVER</option>
                  </select>
                </label>
                <button class="button button--secondary" data-action="save-profile" type="button">Guardar transporte</button>
              </div>
            </article>
          \`;
        }).join('');
      }

      async function refresh() {
        manualRefreshButton.disabled = true;

        try {
          const [healthResponse, jobsResponse, printersResponse] = await Promise.all([
            fetch('/health', { cache: 'no-store' }),
            fetch('/jobs', { cache: 'no-store' }),
            fetch('/printing/status', { cache: 'no-store' }),
          ]);

          if (!healthResponse.ok) {
            throw new Error('No fue posible leer el estado del servicio local.');
          }

          if (!jobsResponse.ok) {
            throw new Error('No fue posible leer el historial de impresion.');
          }

          if (!printersResponse.ok) {
            throw new Error('No fue posible leer el estado de las impresoras.');
          }

          const health = await healthResponse.json();
          const jobsPayload = await jobsResponse.json();
          const printersPayload = await printersResponse.json();
          const jobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];

          renderBackendStatus(health);
          serviceStatusNode.textContent = health.printerModuleReady ? 'Listo' : 'Con incidencias';
          pendingJobsNode.textContent = String(health.queue?.pendingJobs ?? 0);
          activeJobNode.textContent = health.queue?.activeJobLabel || 'Sin trabajo';
          uptimeNode.textContent = String(health.uptimeSeconds ?? 0) + ' s';
          renderJobs(jobs);
          renderPrinters(printersPayload);
          lastRefreshNode.textContent = 'Ultima actualizacion: ' + formatDate(new Date().toISOString());
        } catch (error) {
          backendLinkNode.textContent = 'Sin datos';
          backendStatusNode.textContent = 'Sin datos';
          backendStatusNode.className = 'status status--failed';
          backendStatusDetailNode.textContent = 'No fue posible consultar la vinculacion actual.';
          serviceStatusNode.textContent = 'Error';
          tableContainerNode.innerHTML =
            '<div class="empty error-text">' +
            escapeHtml(error instanceof Error ? error.message : 'No fue posible actualizar el monitor.') +
            '</div>';
          lastRefreshNode.textContent = 'No fue posible actualizar';
        } finally {
          manualRefreshButton.disabled = false;
        }
      }

      async function postJson(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload && payload.message ? payload.message : 'La accion no pudo completarse.');
        }

        return payload;
      }

      async function handlePrinterAction(button) {
        const row = button.closest('[data-printer]');
        const printerName = row && row.dataset.printer;
        const action = button.dataset.action;

        if (!printerName || !action) {
          return;
        }

        button.disabled = true;

        try {
          if (action === 'raw-minimal') {
            await postJson('/printing/diagnostics/raw-minimal', { printerName });
          } else if (action === 'driver') {
            await postJson('/printing/diagnostics/driver', { printerName });
          } else if (action === 'refresh-job') {
            const localJobId = button.dataset.jobId;
            if (localJobId) {
              await postJson('/printing/jobs/' + encodeURIComponent(localJobId) + '/refresh');
            }
          } else if (action === 'cancel') {
            const localJobId = button.dataset.jobId;
            if (localJobId && window.confirm('Cancelar exclusivamente este Windows JobId?')) {
              await postJson('/printing/jobs/' + encodeURIComponent(localJobId) + '/cancel');
            }
          } else if (action === 'unblock') {
            if (window.confirm('Desbloquear esta impresora sin cancelar otros trabajos?')) {
              await postJson('/printing/printers/unblock', { printerName });
            }
          } else if (action === 'save-profile') {
            const transport = row.querySelector('[data-role="transport"]').value;
            await postJson('/printing/printers/profile', {
              systemName: printerName,
              transport,
              paperWidth: row.dataset.paperWidth === '58mm' ? '58mm' : '80mm',
            });
          }

          await refresh();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : 'La accion no pudo completarse.');
        } finally {
          button.disabled = false;
        }
      }

      async function runTestPrint() {
        testPrintButton.disabled = true;
        testPrintFeedback.hidden = true;

        try {
          const payload = await postJson('/print/test', {});
          showTestPrintFeedback(
            formatTestPrintFeedback(payload),
            payload && payload.success === true ? 'ok' : 'error',
          );
          await refresh();
        } catch (error) {
          showTestPrintFeedback(
            error instanceof Error ? error.message : 'No fue posible ejecutar la impresion de prueba.',
            'error',
          );
        } finally {
          testPrintButton.disabled = false;
        }
      }

      async function registerBackend(event) {
        event.preventDefault();

        const pairingCode = pairingCodeInput.value.trim();
        clearBackendFeedback();

        if (!pairingCode) {
          showBackendFeedback('Ingresa el codigo de vinculacion generado en Gestion al Dia.', 'error');
          pairingCodeInput.focus();
          return;
        }

        backendRegisterSubmit.disabled = true;

        try {
          const response = await fetch('/backend/register', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              pairingCode,
            }),
          });
          const payload = await response.json().catch(() => null);

          if (!response.ok || !payload || payload.success !== true) {
            throw new Error(payload && payload.message ? payload.message : 'No fue posible vincular el agente.');
          }

          pairingCodeInput.value = '';
          showBackendFeedback(payload.message, 'ok');
          await refresh();
        } catch (error) {
          showBackendFeedback(
            error instanceof Error ? error.message : 'No fue posible vincular el agente.',
            'error',
          );
        } finally {
          backendRegisterSubmit.disabled = false;
        }
      }

      backendRegisterForm.addEventListener('submit', (event) => {
        void registerBackend(event);
      });

      manualRefreshButton.addEventListener('click', () => {
        void refresh();
      });

      testPrintButton.addEventListener('click', () => {
        void runTestPrint();
      });

      printerContainerNode.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (button) {
          void handlePrinterAction(button);
        }
      });

      void refresh();
      setInterval(() => {
        void refresh();
      }, 5000);
    </script>
  </body>
</html>`;
}
