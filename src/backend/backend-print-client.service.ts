import { io, Socket } from 'socket.io-client';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrintHistoryService } from '../printing/print-history.service';
import { PrintQueueService } from '../printing/print-queue.service';
import { PrinterService } from '../printing/printer.service';
import { formatBackendPrintJob } from '../printing/strategies/print-format-strategy.registry';
import {
  BackendPrintPayload,
  BackendPrintJobType,
} from '../shared/contracts';

type BackendPrintJobStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'PRINTING'
  | 'PRINTED'
  | 'FAILED'
  | 'CANCELLED';

interface BackendPrintJob {
  id: string;
  type: BackendPrintJobType;
  status: BackendPrintJobStatus;
  payload: BackendPrintPayload;
  printer: {
    id: string;
    name: string;
    systemName: string;
    paperWidth: number;
    copies: number;
  };
}

interface RegisterBackendAgentResponse {
  agentId: string;
  businessId: string;
  deviceToken: string;
}

interface SyncBackendPrintersResponse {
  accepted: boolean;
  synced: number;
}

interface BackendRuntimeErrorSnapshot {
  at: string;
  message: string;
}

type BackendPrintJobEventLevel = 'INFO' | 'WARN' | 'ERROR';

interface BackendPrintJobEvent {
  level?: BackendPrintJobEventLevel;
  stage: string;
  code?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface BackendRuntimeStatusSnapshot {
  connected: boolean;
  lastContactAt?: string;
  lastError?: BackendRuntimeErrorSnapshot;
  lastDisconnectReason?: string;
}

class BackendAgentAuthExpiredError extends Error {
  constructor(readonly statusCode: 401 | 403) {
    super(`Backend respondió ${statusCode}`);
    this.name = 'BackendAgentAuthExpiredError';
  }
}

export interface BackendPrintClientDependencies {
  version: string;
  configService: AppConfigService;
  logger: LoggerService;
  printerService: PrinterService;
  queueService: PrintQueueService;
  printHistoryService: PrintHistoryService;
  notify?: (title: string, content: string) => void;
}

const DEFAULT_BACKEND_BASE_URL =
  'https://app-pos-gestion-total-node.purplebush-d0f1177f.centralus.azurecontainerapps.io';
const HEARTBEAT_INTERVAL_MS = 25_000;
const POLLING_INTERVAL_MS = 7_000;
const BACKEND_REQUEST_TIMEOUT_MS = 20_000;
const PRINTED_ACK_ATTEMPTS = 3;
const SPOOL_WATCHDOG_DELAY_MS = 45_000;

export class BackendPrintClientService {
  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private authExpiredHandled = false;
  private isSocketConnected = false;
  private lastSuccessfulContactAt: string | null = null;
  private lastErrorSnapshot: BackendRuntimeErrorSnapshot | null = null;
  private lastDisconnectReason: string | null = null;

  constructor(private readonly dependencies: BackendPrintClientDependencies) {}

  start(): void {
    this.stop();
    const config = this.dependencies.configService.getConfig();

    if (!config.backendDeviceToken) {
      this.dependencies.logger.info('Cliente backend de impresion sin vincular.');
      return;
    }

    this.authExpiredHandled = false;

    this.connectSocket();
    void this.sendHeartbeat();
    void this.syncPrinters();
    void this.processNextPending();

    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();

    this.pollingTimer = setInterval(() => {
      void this.processNextPending();
    }, POLLING_INTERVAL_MS);
    this.pollingTimer.unref?.();
  }

  stop(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.isSocketConnected = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  async register(pairingCode: string): Promise<RegisterBackendAgentResponse> {
    const baseUrl = this.resolveBaseUrl();
    const response = await this.request<RegisterBackendAgentResponse>(
      baseUrl,
      '/print-agents/register',
      {
        method: 'POST',
        body: {
          pairingCode,
          deviceName: this.resolveDeviceName(),
          platform: 'WINDOWS',
          version: this.dependencies.version,
          machineName: this.resolveDeviceName(),
          deviceId: this.resolveDeviceName(),
        },
      },
      null,
    );

    this.dependencies.configService.saveConfig({
      backendAgentId: response.agentId,
      backendBusinessId: response.businessId,
      backendDeviceToken: response.deviceToken,
    });
    this.authExpiredHandled = false;
    this.start();
    return response;
  }

  async syncPrintersNow(): Promise<SyncBackendPrintersResponse> {
    const config = this.dependencies.configService.getConfig();
    const token = config.backendDeviceToken;

    if (!token) {
      throw new Error('El agente todavia no esta vinculado con Gestion al Dia.');
    }

    const printers = await this.dependencies.printerService.listPrinters();
    const response = await this.request<SyncBackendPrintersResponse>(
      this.resolveBaseUrl(),
      '/print-agents/printers/sync',
      {
        method: 'POST',
        body: {
          printers: printers.map((printer) => ({
            name: printer.name,
            systemName: printer.name,
            isDefault: printer.isDefault,
          })),
        },
      },
      token,
    );

    this.dependencies.logger.info('Impresoras sincronizadas con el backend.', {
      synced: response.synced,
    });
    this.recordSuccessfulContact();

    return response;
  }

  private connectSocket(): void {
    const config = this.dependencies.configService.getConfig();
    const token = config.backendDeviceToken;

    if (!token) {
      return;
    }

    const socketBaseUrl = new URL(this.resolveBaseUrl());
    this.socket = io(`${socketBaseUrl.origin}/print-agents`, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 30_000,
    });

    this.socket.on('connect', () => {
      this.isSocketConnected = true;
      this.lastDisconnectReason = null;
      this.recordSuccessfulContact();
      this.dependencies.logger.info('Conectado al WebSocket de impresion backend.');
      void this.sendHeartbeat();
      void this.syncPrinters();
      void this.processNextPending();
    });
    this.socket.on('connect_error', (error) => {
      this.isSocketConnected = false;
      this.recordBackendError(
        error instanceof Error ? error.message : String(error),
      );
      this.dependencies.logger.warn('Fallo la autenticacion o conexion del WebSocket de impresion.', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.socket.on('print-job.created', () => {
      void this.processNextPending();
    });
    this.socket.on('disconnect', (reason) => {
      this.isSocketConnected = false;
      this.lastDisconnectReason = reason;
      this.dependencies.logger.warn('WebSocket de impresion desconectado.', { reason });
    });
  }

  private async sendHeartbeat(): Promise<void> {
    const config = this.dependencies.configService.getConfig();
    const token = config.backendDeviceToken;

    if (!token) {
      return;
    }

    try {
      await this.request(this.resolveBaseUrl(), '/print-agents/heartbeat', {
        method: 'POST',
        body: { version: this.dependencies.version },
      }, token);
      this.recordSuccessfulContact();
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

      this.recordBackendError(
        error instanceof Error ? error.message : String(error),
      );
      this.dependencies.logger.warn('No fue posible enviar heartbeat al backend.', error);
    }
  }

  private async syncPrinters(): Promise<void> {
    try {
      await this.syncPrintersNow();
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

      this.recordBackendError(
        error instanceof Error ? error.message : String(error),
      );
      this.dependencies.logger.warn('No fue posible sincronizar impresoras con backend.', error);
    }
  }

  private async processNextPending(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    const config = this.dependencies.configService.getConfig();
    const token = config.backendDeviceToken;

    if (!token) {
      return;
    }

    this.isProcessing = true;

    try {
      while (true) {
        const job = await this.request<BackendPrintJob | null>(
          this.resolveBaseUrl(),
          '/print-jobs/next-pending',
          { method: 'GET' },
          token,
        );

        if (!job) {
          return;
        }

        const claimedJob = await this.request<BackendPrintJob>(
          this.resolveBaseUrl(),
          `/print-jobs/${encodeURIComponent(job.id)}/claim`,
          { method: 'POST' },
          token,
        );

        this.dependencies.logger.info('Trabajo de impresion backend reclamado.', {
          jobId: claimedJob.id,
          type: claimedJob.type,
          printerName: claimedJob.printer.systemName || claimedJob.printer.name,
        });

        const printed = await this.printClaimedJob(claimedJob, token);
        if (!printed) {
          return;
        }
      }
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

      this.recordBackendError(
        error instanceof Error ? error.message : String(error),
      );
      this.dependencies.logger.warn('No fue posible procesar trabajos pendientes del backend.', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async printClaimedJob(job: BackendPrintJob, token: string): Promise<boolean> {
    const baseUrl = this.resolveBaseUrl();
    const printerName = job.printer.systemName || job.printer.name;
    let payload: BackendPrintPayload;
    let copies = 1;
    let buffer: Buffer;

    try {
      payload = this.normalizePayload(job);
      copies = Math.max(1, Math.min(5, Math.trunc(payload.options?.copies ?? job.printer.copies ?? 1)));
      buffer = this.formatJob(job.type, payload);
    } catch (error) {
      await this.reportPrintJobFailed(baseUrl, token, job, error, {
        stage: 'FORMAT_FAILED',
        code: 'FORMAT_FAILED',
        metadata: {
          printerName,
        },
      });
      return false;
    }

    await this.recordPrintJobEvent(token, job, {
      stage: 'FORMAT_COMPLETED',
      metadata: {
        printerName,
        copies,
        paperWidth: payload.options?.paperWidth,
        escposBytes: buffer.length,
        showTotals: payload.options?.showTotals,
        showItemPrices: payload.options?.showItemPrices,
      },
    });

    try {
      await this.request(baseUrl, `/print-jobs/${encodeURIComponent(job.id)}/printing`, { method: 'POST' }, token);
      await this.recordPrintJobEvent(token, job, {
        stage: 'BACKEND_PRINTING_MARKED',
        metadata: {
          printerName,
        },
      });
      this.dependencies.logger.info('Trabajo marcado como imprimiendo en backend.', {
        jobId: job.id,
        printerName,
      });
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        throw error;
      }

      await this.reportPrintJobFailed(baseUrl, token, job, error, {
        stage: 'BACKEND_MARK_PRINTING_FAILED',
        code: 'BACKEND_MARK_PRINTING_FAILED',
        metadata: {
          printerName,
        },
      });
      return false;
    }

    let acceptedCopies = 0;

    try {
      for (let index = 0; index < copies; index += 1) {
        const label = copies > 1 ? `${job.type}-${job.id}-${index + 1}` : `${job.type}-${job.id}`;
        const historyId = this.dependencies.printHistoryService.recordQueued(label, printerName);
        const copyNumber = index + 1;
        await this.recordPrintJobEvent(token, job, {
          stage: 'SPOOL_START',
          metadata: {
            printerName,
            label,
            copyNumber,
            copies,
            escposBytes: buffer.length,
          },
        });
        await this.dependencies.queueService.enqueue(label, async () => {
          this.dependencies.printHistoryService.markProcessing(historyId);
          try {
            await this.dependencies.printerService.printRaw(printerName, label, buffer);
            acceptedCopies += 1;
            this.dependencies.printHistoryService.markCompleted(historyId);
            await this.recordPrintJobEvent(token, job, {
              stage: 'SPOOL_ACCEPTED',
              metadata: {
                printerName,
                label,
                copyNumber,
                copies,
                escposBytes: buffer.length,
              },
            });
            this.scheduleSpoolWatchdog(token, job, {
              printerName,
              label,
              copyNumber,
              copies,
            });
          } catch (error) {
            this.dependencies.printHistoryService.markFailed(historyId, error);
            await this.recordPrintJobEvent(token, job, {
              level: 'ERROR',
              stage: 'SPOOL_FAILED',
              code: this.mapPrintError(error),
              message: this.errorMessage(error),
              metadata: {
                printerName,
                label,
                copyNumber,
                copies,
                acceptedCopies,
              },
            });
            throw error;
          }
        });
      }
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        throw error;
      }

      this.dependencies.logger.warn('Trabajo de impresion backend fallido.', {
        jobId: job.id,
        printerName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordBackendError(
        error instanceof Error ? error.message : String(error),
      );

      if (acceptedCopies > 0) {
        await this.recordPrintJobEvent(token, job, {
          level: 'WARN',
          stage: 'SPOOL_PARTIAL_FAILURE',
          code: 'SPOOL_PARTIAL_FAILURE',
          message:
            'Windows acepto al menos una copia antes del error. Verifica el papel antes de reintentar.',
          metadata: {
            printerName,
            acceptedCopies,
            copies,
          },
        });
        return false;
      }

      await this.reportPrintJobFailed(baseUrl, token, job, error, {
        stage: 'PRINT_FAILED',
        metadata: {
          printerName,
          copies,
        },
      });
      return false;
    }

    const markedPrinted = await this.markPrintedInBackendWithRetry(
      baseUrl,
      token,
      job,
      {
        printerName,
        copies,
        acceptedCopies,
      },
    );

    if (!markedPrinted) {
      return false;
    }

    this.dependencies.logger.info('Trabajo marcado como impreso en backend.', {
      jobId: job.id,
      printerName,
      copies,
    });
    this.recordSuccessfulContact();
    return true;
  }

  private normalizePayload(job: BackendPrintJob): BackendPrintPayload {
    return {
      ...job.payload,
      options: {
        ...job.payload.options,
        paperWidth:
          job.payload.options?.paperWidth ?? (job.printer.paperWidth === 58 ? '58mm' : '80mm'),
        copies: job.payload.options?.copies ?? job.printer.copies,
      },
    };
  }

  private formatJob(type: BackendPrintJob['type'], payload: BackendPrintPayload): Buffer {
    return formatBackendPrintJob(type, payload);
  }

  private async markPrintedInBackendWithRetry(
    baseUrl: string,
    token: string,
    job: BackendPrintJob,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= PRINTED_ACK_ATTEMPTS; attempt += 1) {
      try {
        await this.request(
          baseUrl,
          `/print-jobs/${encodeURIComponent(job.id)}/printed`,
          { method: 'POST' },
          token,
        );
        await this.recordPrintJobEvent(token, job, {
          stage: 'BACKEND_PRINTED_MARKED',
          metadata: {
            ...metadata,
            ackAttempt: attempt,
          },
        });
        return true;
      } catch (error) {
        if (error instanceof BackendAgentAuthExpiredError) {
          throw error;
        }

        lastError = error;
      }
    }

    this.recordBackendError(this.errorMessage(lastError));
    this.dependencies.logger.warn(
      'El trabajo fue entregado a Windows, pero no se pudo confirmar como impreso en backend.',
      {
        jobId: job.id,
        error: this.errorMessage(lastError),
      },
    );
    await this.recordPrintJobEvent(token, job, {
      level: 'WARN',
      stage: 'BACKEND_ACK_FAILED',
      code: 'BACKEND_ACK_FAILED',
      message:
        'Windows acepto el trabajo, pero el backend no confirmo el estado PRINTED. No se reporta como failed para evitar duplicados.',
      metadata: {
        ...metadata,
        ackAttempts: PRINTED_ACK_ATTEMPTS,
        error: this.errorMessage(lastError),
      },
    });
    return false;
  }

  private async reportPrintJobFailed(
    baseUrl: string,
    token: string,
    job: BackendPrintJob,
    error: unknown,
    options: {
      stage: string;
      code?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const errorCode = options.code ?? this.mapPrintError(error);
    const errorMessage = this.errorMessage(error);

    this.dependencies.logger.warn('Trabajo de impresion backend fallido.', {
      jobId: job.id,
      errorCode,
      error: errorMessage,
    });
    this.recordBackendError(errorMessage);
    await this.recordPrintJobEvent(token, job, {
      level: 'ERROR',
      stage: options.stage,
      code: errorCode,
      message: errorMessage,
      metadata: options.metadata,
    });
    await this.request(
      baseUrl,
      `/print-jobs/${encodeURIComponent(job.id)}/failed`,
      {
        method: 'POST',
        body: {
          errorCode,
          errorMessage,
        },
      },
      token,
    ).catch(() => undefined);
  }

  private async recordPrintJobEvent(
    token: string,
    job: BackendPrintJob,
    event: BackendPrintJobEvent,
  ): Promise<void> {
    await this.request(
      this.resolveBaseUrl(),
      `/print-jobs/${encodeURIComponent(job.id)}/events`,
      {
        method: 'POST',
        body: {
          ...event,
          metadata: {
            jobType: job.type,
            printerId: job.printer.id,
            printerName: job.printer.name,
            printerSystemName: job.printer.systemName,
            ...event.metadata,
          },
        },
      },
      token,
    ).catch((error) => {
      this.dependencies.logger.warn('No fue posible registrar evento de impresion en backend.', {
        jobId: job.id,
        stage: event.stage,
        error: this.errorMessage(error),
      });
    });
  }

  private scheduleSpoolWatchdog(
    token: string,
    job: BackendPrintJob,
    options: {
      printerName: string;
      label: string;
      copyNumber: number;
      copies: number;
    },
  ): void {
    const timeout = setTimeout(() => {
      void this.checkSpoolJobAfterDelay(token, job, options);
    }, SPOOL_WATCHDOG_DELAY_MS);
    timeout.unref?.();
  }

  private async checkSpoolJobAfterDelay(
    token: string,
    job: BackendPrintJob,
    options: {
      printerName: string;
      label: string;
      copyNumber: number;
      copies: number;
    },
  ): Promise<void> {
    const findSpoolJob = this.dependencies.printerService.findSpoolJob?.bind(
      this.dependencies.printerService,
    );

    if (!findSpoolJob) {
      return;
    }

    try {
      const spoolJob = await findSpoolJob(options.printerName, options.label);

      if (!spoolJob) {
        await this.recordPrintJobEvent(token, job, {
          stage: 'SPOOL_CLEARED',
          metadata: options,
        });
        return;
      }

      await this.recordPrintJobEvent(token, job, {
        level: 'WARN',
        stage: 'SPOOL_STILL_ACTIVE',
        code: 'SPOOL_STUCK',
        message:
          'Windows todavia muestra el trabajo en cola. Revisa papel, tapa, cutter, driver o cola de impresion antes de reintentar.',
        metadata: {
          ...options,
          spoolJob,
        },
      });
    } catch (error) {
      await this.recordPrintJobEvent(token, job, {
        level: 'WARN',
        stage: 'SPOOL_WATCHDOG_FAILED',
        code: 'SPOOL_WATCHDOG_FAILED',
        message: this.errorMessage(error),
        metadata: options,
      });
    }
  }

  private async request<T>(
    baseUrl: string,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
    token: string | null,
  ): Promise<T> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, BACKEND_REQUEST_TIMEOUT_MS);

    let response: Response;

    try {
      response = await fetch(new URL(path, baseUrl), {
        method: options.method,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(
          `La solicitud al backend excedio ${BACKEND_REQUEST_TIMEOUT_MS / 1000}s en ${path}.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.handleBackendAuthenticationExpired(response.status);
        throw new BackendAgentAuthExpiredError(response.status);
      }

      throw new Error(`Backend respondió ${response.status}`);
    }

    this.recordSuccessfulContact();
    return this.parseJsonResponse<T>(response, path);
  }

  private async parseJsonResponse<T>(response: Response, path: string): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    if (typeof response.text === 'function') {
      const rawBody = await response.text();
      const normalizedBody = rawBody.trim();

      if (!normalizedBody) {
        return undefined as T;
      }

      try {
        return JSON.parse(normalizedBody) as T;
      } catch {
        throw new Error(
          `Backend respondio ${response.status} con cuerpo no JSON en ${path}: ${this.previewResponseBody(normalizedBody)}`,
        );
      }
    }

    if (typeof response.json === 'function') {
      return (await response.json()) as T;
    }

    return undefined as T;
  }

  private previewResponseBody(value: string): string {
    const normalizedValue = value.replace(/\s+/g, ' ').trim();

    if (!normalizedValue) {
      return '<vacio>';
    }

    return normalizedValue.length > 160
      ? `${normalizedValue.slice(0, 160)}...`
      : normalizedValue;
  }

  private handleBackendAuthenticationExpired(statusCode: 401 | 403): void {
    if (this.authExpiredHandled) {
      return;
    }

    this.authExpiredHandled = true;
    this.stop();
    this.dependencies.configService.saveConfig({
      backendDeviceToken: null,
    });
    this.dependencies.logger.warn('Sesion del agente expirada o revocada. Se requiere nuevo pairing.', {
      statusCode,
    });
    this.dependencies.notify?.(
      'Gestion al Dia Print Agent',
      'Sesion expirada. Realiza el pairing nuevamente.',
    );
  }

  private resolveBaseUrl(): string {
    const configuredBaseUrl = this.dependencies.configService.getConfig().backendBaseUrl;
    return configuredBaseUrl || DEFAULT_BACKEND_BASE_URL;
  }

  private resolveDeviceName(): string {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || 'Gestion al Dia Print Agent';
  }

  private mapPrintError(error: unknown): string {
    const message = this.errorMessage(error);

    if (/not found|no encontrada|no existe/i.test(message)) {
      return 'PRINTER_NOT_FOUND';
    }

    if (/timeout|tiempo/i.test(message)) {
      return 'PRINT_TIMEOUT';
    }

    if (/offline|desconect/i.test(message)) {
      return 'PRINTER_OFFLINE';
    }

    return 'UNKNOWN_ERROR';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
      ? error.message.trim()
      : String(error);
  }

  getStatusSnapshot(): BackendRuntimeStatusSnapshot {
    return {
      connected: this.isSocketConnected,
      lastContactAt: this.lastSuccessfulContactAt ?? undefined,
      lastError: this.lastErrorSnapshot ?? undefined,
      lastDisconnectReason: this.lastDisconnectReason ?? undefined,
    };
  }

  private recordSuccessfulContact(): void {
    this.lastSuccessfulContactAt = new Date().toISOString();
    this.lastErrorSnapshot = null;
  }

  private recordBackendError(message: string): void {
    const normalizedMessage = message.trim();
    this.lastErrorSnapshot = {
      at: new Date().toISOString(),
      message: normalizedMessage || 'Ocurrio un error de comunicacion con el backend.',
    };
  }
}
