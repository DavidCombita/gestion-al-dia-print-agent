import http from 'node:http';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { shell } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrintHistoryService } from '../printing/print-history.service';
import { PrintQueueService } from '../printing/print-queue.service';
import { PrinterService } from '../printing/printer.service';
import {
  AgentHealthResponse,
  AgentMutationResponse,
  PrintJobsResponse,
  ReceiptJobPayload,
} from '../shared/contracts';
import { createCorsOptions } from '../security/cors.config';
import { PairingTokenService } from '../security/pairing-token.service';
import { BackendPrintClientService } from '../backend/backend-print-client.service';
import { sanitizeAppConfig } from '../config/config.schema';
import { formatInvoice } from '../printing/formatters/invoice.formatter';
import { formatKitchenOrder } from '../printing/formatters/kitchen-order.formatter';
import { formatTestTicket } from '../printing/formatters/test-ticket.formatter';

const HOST = '127.0.0.1';
const PORT = 3088;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 30_000;
const SERVER_HEADERS_TIMEOUT_MS = 35_000;
const SERVER_REQUEST_TIMEOUT_MS = 95_000;
const REQUEST_HANDLER_TIMEOUT_MS = 90_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;

export interface LocalServerDependencies {
  version: string;
  startedAt: number;
  configService: AppConfigService;
  logger: LoggerService;
  queueService: PrintQueueService;
  printerService: PrinterService;
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
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use((request, response, next) => {
      const isPrivateNetworkPreflight =
        request.header('access-control-request-private-network')?.toLowerCase() === 'true';
      const origin = request.header('origin');
      const allowedOrigins = this.dependencies.configService.getConfig().allowedOrigins;

      if (isPrivateNetworkPreflight && origin && allowedOrigins.includes(origin)) {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.vary('Access-Control-Request-Private-Network');
      }

      next();
    });
    this.app.use(cors(createCorsOptions(this.dependencies.configService)));
    this.app.use((request, response, next) => {
      response.setTimeout(REQUEST_HANDLER_TIMEOUT_MS, () => {
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
      const printerModuleStatus = await this.dependencies.printerService.getModuleStatus();
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
          printers: await this.dependencies.printerService.listPrinters(),
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
        const backendBaseUrl = normalizeNullableString(request.body?.backendBaseUrl, null);

        if (!pairingCode) {
          throw new Error('Ingresa el codigo de vinculacion generado en Gestion al Dia.');
        }

        const registration = await this.dependencies.backendPrintClient.register(
          pairingCode,
          backendBaseUrl ?? undefined,
        );

        response.json({
          success: true,
          message: 'Agente vinculado con el backend de Gestion al Dia.',
          registration,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/test', async (_request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        const payload = buildTestPayload(config.paperWidth);
        const printerName = this.dependencies.printerService.resolvePrinterName('invoice');
        await this.enqueuePrint('ticket-de-prueba', printerName, formatTestTicket(payload));
        this.sendSuccess(response, 'Ticket de prueba enviado a la impresora configurada.');
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
        const printerName = this.dependencies.printerService.resolvePrinterName('invoice');
        const buffer = formatInvoice({
          ...payload,
          options: {
            ...payload.options,
            copies,
            paperWidth: payload.options?.paperWidth ?? config.paperWidth,
          },
        });

        await this.enqueueCopies('factura', printerName, buffer, copies);
        this.sendSuccess(response, 'Factura enviada al agente local.');
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
        const printerName = this.dependencies.printerService.resolvePrinterName('kitchen');
        const buffer = formatKitchenOrder({
          ...payload,
          options: {
            ...payload.options,
            copies,
            paperWidth: payload.options?.paperWidth ?? config.paperWidth,
          },
        });

        await this.enqueueCopies('comanda-cocina', printerName, buffer, copies);
        this.sendSuccess(response, 'Comanda enviada al agente local.');
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

  private async enqueuePrint(
    label: string,
    printerName: string,
    buffer: Buffer,
  ): Promise<void> {
    const jobId = this.dependencies.printHistoryService.recordQueued(label, printerName);

    await this.dependencies.queueService.enqueue(label, async () => {
      this.dependencies.printHistoryService.markProcessing(jobId);

      try {
        await this.dependencies.printerService.printRaw(printerName, label, buffer);
        this.dependencies.printHistoryService.markCompleted(jobId);
      } catch (error) {
        this.dependencies.printHistoryService.markFailed(jobId, error);
        throw error;
      }
    });
  }

  private async enqueueCopies(
    label: string,
    printerName: string,
    buffer: Buffer,
    copies: number,
  ): Promise<void> {
    for (let index = 0; index < Math.max(1, Math.trunc(copies)); index += 1) {
      const currentLabel = copies > 1 ? `${label}-${index + 1}` : label;
      await this.enqueuePrint(currentLabel, printerName, buffer);
    }
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

function normalizeNullableString(value: unknown, fallback: string | null): string | null {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
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

  if (request.method !== 'GET') {
    return false;
  }

  if (request.path === '/config') {
    const origin = request.header('origin');
    return Boolean(origin && configService.getConfig().allowedOrigins.includes(origin));
  }

  if (request.path !== '/jobs') {
    return false;
  }

  return isLoopbackAddress(request.socket.remoteAddress);
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
        background:
          radial-gradient(circle at top right, rgba(31, 120, 255, 0.16), transparent 28%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
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

      .refresh-pill {
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.82);
        color: var(--muted);
        border-radius: 999px;
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
        border-radius: 20px;
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
        border-radius: 24px;
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
        background: linear-gradient(135deg, rgba(31, 120, 255, 0.08), rgba(255, 255, 255, 0.92));
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
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .status--queued,
      .status--processing {
        color: var(--warn);
        background: rgba(183, 121, 31, 0.12);
      }

      .status--completed {
        color: var(--ok);
        background: rgba(19, 138, 82, 0.12);
      }

      .status--failed {
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
        border-radius: 18px;
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
        border-radius: 14px;
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
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .button--primary {
        background: var(--accent);
        color: #fff;
        box-shadow: var(--shadow);
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
        border-radius: 16px;
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
            Aqui puedes ver el estado del servicio local, vincular este equipo con el backend
            usando el codigo de seguridad y revisar los ultimos trabajos enviados a impresora.
          </p>
        </div>
        <div id="last-refresh" class="refresh-pill">Actualizando...</div>
      </section>

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
          <span>Conexion backend</span>
          <strong id="backend-link">Sin vincular</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel__head">
          <div>
            <h2>Vinculacion con Gestion al Dia</h2>
            <p>Ingresa el codigo temporal generado en la app para registrar este equipo.</p>
          </div>
          <span id="backend-status" class="status status--queued">Sin vincular</span>
        </div>
        <div class="panel__body panel__body--split">
          <div class="backend-meta">
            <article class="meta-item">
              <span>Estado actual</span>
              <strong id="backend-status-detail">Pendiente de vinculacion</strong>
            </article>
            <article class="meta-item">
              <span>URL backend</span>
              <strong id="backend-base-url-current">Sin configurar</strong>
            </article>
            <article class="meta-item">
              <span>Agente</span>
              <strong id="backend-agent-id">Sin registrar</strong>
            </article>
            <article class="meta-item">
              <span>Negocio</span>
              <strong id="backend-business-id">Sin registrar</strong>
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

            <label class="field">
              <span>URL del backend (opcional)</span>
              <input
                id="backend-base-url"
                name="backendBaseUrl"
                type="url"
                placeholder="https://tu-backend"
              />
            </label>

            <div class="form-actions">
              <button id="backend-register-submit" class="button button--primary" type="submit">
                Vincular agente
              </button>
            </div>

            <p class="form-help">
              Si dejas la URL vacia, el agente usara la direccion predeterminada configurada para
              Produccion.
            </p>

            <div id="backend-register-feedback" class="notice" hidden></div>
          </form>
        </div>
      </section>

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
      const backendBaseUrlCurrentNode = document.getElementById('backend-base-url-current');
      const backendAgentIdNode = document.getElementById('backend-agent-id');
      const backendBusinessIdNode = document.getElementById('backend-business-id');
      const backendRegisterForm = document.getElementById('backend-register-form');
      const pairingCodeInput = document.getElementById('pairing-code');
      const backendBaseUrlInput = document.getElementById('backend-base-url');
      const backendRegisterSubmit = document.getElementById('backend-register-submit');
      const backendRegisterFeedback = document.getElementById('backend-register-feedback');
      const tableContainerNode = document.getElementById('table-container');
      const manualRefreshButton = document.getElementById('manual-refresh');
      let backendBaseUrlWasEdited = false;

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
              baseUrl: null,
              agentId: null,
              businessId: null,
            };
        const linked = backend.linked === true;

        backendLinkNode.textContent = linked ? 'Vinculado' : 'Pendiente';
        backendStatusNode.textContent = linked ? 'Vinculado' : 'Sin vincular';
        backendStatusNode.className = 'status ' + (linked ? 'status--completed' : 'status--queued');
        backendStatusDetailNode.textContent = linked
          ? 'El agente ya puede recibir trabajos desde el backend.'
          : 'Ingresa el codigo temporal para registrar este equipo.';
        backendBaseUrlCurrentNode.textContent = backend.baseUrl || 'Sin configurar';
        backendAgentIdNode.textContent = backend.agentId || 'Sin registrar';
        backendBusinessIdNode.textContent = backend.businessId || 'Sin registrar';

        if (!backendBaseUrlWasEdited && !backendBaseUrlInput.value.trim() && backend.baseUrl) {
          backendBaseUrlInput.value = backend.baseUrl;
        }
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
                  <div class="job-label">\${escapeHtml(job.label)}</div>
                  <span class="job-meta">ID: \${escapeHtml(job.id)}</span>
                </td>
                <td>\${escapeHtml(job.printerName)}</td>
                <td><span class="status status--\${escapeHtml(job.status)}">\${escapeHtml(job.status)}</span></td>
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

      async function refresh() {
        manualRefreshButton.disabled = true;

        try {
          const [healthResponse, jobsResponse] = await Promise.all([
            fetch('/health', { cache: 'no-store' }),
            fetch('/jobs', { cache: 'no-store' }),
          ]);

          if (!healthResponse.ok) {
            throw new Error('No fue posible leer el estado del servicio local.');
          }

          if (!jobsResponse.ok) {
            throw new Error('No fue posible leer el historial de impresion.');
          }

          const health = await healthResponse.json();
          const jobsPayload = await jobsResponse.json();
          const jobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];

          renderBackendStatus(health);
          serviceStatusNode.textContent = health.printerModuleReady ? 'Listo' : 'Con incidencias';
          pendingJobsNode.textContent = String(health.queue?.pendingJobs ?? 0);
          activeJobNode.textContent = health.queue?.activeJobLabel || 'Sin trabajo';
          uptimeNode.textContent = String(health.uptimeSeconds ?? 0) + ' s';
          renderJobs(jobs);
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

      async function registerBackend(event) {
        event.preventDefault();

        const pairingCode = pairingCodeInput.value.trim();
        const backendBaseUrl = backendBaseUrlInput.value.trim();
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
              backendBaseUrl: backendBaseUrl || null,
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

      backendBaseUrlInput.addEventListener('input', () => {
        backendBaseUrlWasEdited = true;
      });

      backendRegisterForm.addEventListener('submit', (event) => {
        void registerBackend(event);
      });

      manualRefreshButton.addEventListener('click', () => {
        void refresh();
      });

      void refresh();
      setInterval(() => {
        void refresh();
      }, 5000);
    </script>
  </body>
</html>`;
}
