import crypto from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrintExecutionResult } from '../printing/contracts/print-result';
import { PrintOrchestratorService } from '../printing/print-orchestrator.service';
import { PrinterDiscoveryService } from '../printing/printers/printer-discovery.service';
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
    super(`Backend respondio ${statusCode}`);
    this.name = 'BackendAgentAuthExpiredError';
  }
}

export interface BackendPrintClientDependencies {
  version: string;
  configService: AppConfigService;
  logger: LoggerService;
  printerDiscoveryService: PrinterDiscoveryService;
  printOrchestrator: PrintOrchestratorService;
  notify?: (title: string, content: string) => void;
}

const DEFAULT_BACKEND_BASE_URL =
  'https://app-pos-gestion-total-node.purplebush-d0f1177f.centralus.azurecontainerapps.io';
const HEARTBEAT_INTERVAL_MS = 25_000;
const POLLING_INTERVAL_MS = 7_000;
const BACKEND_REQUEST_TIMEOUT_MS = 20_000;
const PRINTED_ACK_ATTEMPTS = 3;

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

  constructor(readonly dependencies: BackendPrintClientDependencies) {}

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
    const deviceName = this.resolveDeviceName();
    const deviceId = this.resolveDeviceId();
    const response = await this.request<RegisterBackendAgentResponse>(
      this.resolveBaseUrl(),
      '/print-agents/register',
      {
        method: 'POST',
        body: {
          pairingCode,
          deviceName,
          platform: 'WINDOWS',
          version: this.dependencies.version,
          machineName: deviceName,
          deviceId,
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
    const token = this.dependencies.configService.getConfig().backendDeviceToken;

    if (!token) {
      throw new Error('El agente todavia no esta vinculado con Gestion al Dia.');
    }

    const printers = await this.dependencies.printerDiscoveryService.listPrinters();
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
    const token = this.dependencies.configService.getConfig().backendDeviceToken;

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
      this.recordBackendError(error instanceof Error ? error.message : String(error));
      this.dependencies.logger.warn(
        'Fallo la autenticacion o conexion del WebSocket de impresion.',
        { error: error instanceof Error ? error.message : String(error) },
      );
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
    const token = this.dependencies.configService.getConfig().backendDeviceToken;

    if (!token) {
      return;
    }

    try {
      await this.request(
        this.resolveBaseUrl(),
        '/print-agents/heartbeat',
        { method: 'POST', body: { version: this.dependencies.version } },
        token,
      );
      this.recordSuccessfulContact();
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

      this.recordBackendError(this.errorMessage(error));
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

      this.recordBackendError(this.errorMessage(error));
      this.dependencies.logger.warn(
        'No fue posible sincronizar impresoras con backend.',
        error,
      );
    }
  }

  private async processNextPending(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    const token = this.dependencies.configService.getConfig().backendDeviceToken;

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
          backendJobId: claimedJob.id,
          jobType: claimedJob.type,
          printerName:
            claimedJob.printer.systemName || claimedJob.printer.name,
        });

        const completed = await this.printClaimedJob(claimedJob, token);
        if (!completed) {
          return;
        }
      }
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

      this.recordBackendError(this.errorMessage(error));
      this.dependencies.logger.warn(
        'No fue posible procesar trabajos pendientes del backend.',
        error,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  private async printClaimedJob(
    job: BackendPrintJob,
    token: string,
  ): Promise<boolean> {
    const baseUrl = this.resolveBaseUrl();
    const printerName = job.printer.systemName || job.printer.name;

    try {
      await this.request(
        baseUrl,
        `/print-jobs/${encodeURIComponent(job.id)}/printing`,
        { method: 'POST' },
        token,
      );
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        throw error;
      }

      await this.reportPrintJobFailed(baseUrl, token, job, error, {
        stage: 'BACKEND_MARK_PRINTING_FAILED',
        code: 'BACKEND_MARK_PRINTING_FAILED',
      });
      return false;
    }

    let result: PrintExecutionResult;

    try {
      result = await this.dependencies.printOrchestrator.execute({
        source: 'BACKEND',
        backendJobId: job.id,
        jobType: job.type,
        payload: job.payload,
        printerName,
        displayPrinterName: job.printer.name,
        copies: job.payload.options?.copies ?? job.printer.copies,
        paperWidth: job.printer.paperWidth === 58 ? '58mm' : '80mm',
      });
    } catch (error) {
      await this.reportPrintJobFailed(baseUrl, token, job, error, {
        stage: 'PRINT_ORCHESTRATION_FAILED',
      });
      return false;
    }

    await this.recordExecutionResult(token, job, result);

    if (result.status === 'SPOOL_COMPLETED') {
      return this.markPrintedInBackendWithRetry(baseUrl, token, job, {
        printerName,
        transport: result.transport,
        copies: result.copies,
        localJobIds: result.attempts.map((attempt) => attempt.localJobId),
        windowsJobIds: result.attempts
          .map((attempt) => attempt.systemJobId)
          .filter((jobId): jobId is number => typeof jobId === 'number'),
      });
    }

    const anySubmitted = result.attempts.some((attempt) => attempt.submitted);

    if (!anySubmitted && result.retrySafety === 'SAFE_TO_RETRY') {
      const firstFailure = result.attempts[0];
      await this.reportPrintJobFailed(
        baseUrl,
        token,
        job,
        new Error(firstFailure?.errorMessage ?? 'La impresion fallo antes del submit.'),
        {
          stage: 'PRINT_FAILED_BEFORE_SUBMIT',
          code: firstFailure?.errorCode,
          metadata: { resultStatus: result.status },
        },
      );
      return false;
    }

    await this.recordPrintJobEvent(token, job, {
      level: 'WARN',
      stage: 'PRINT_UNRESOLVED_UNSAFE_TO_RETRY',
      code:
        result.status === 'PARTIAL_FAILURE'
          ? 'PARTIAL_FAILURE'
          : `PRINT_${result.status}`,
      message:
        'Windows acepto al menos un trabajo sin confirmacion segura. No se reintentara automaticamente para evitar duplicados.',
      metadata: {
        resultStatus: result.status,
        retrySafety: result.retrySafety,
        printerName,
        transport: result.transport,
      },
    });
    return false;
  }

  private async recordExecutionResult(
    token: string,
    job: BackendPrintJob,
    result: PrintExecutionResult,
  ): Promise<void> {
    for (const attempt of result.attempts) {
      await this.recordPrintJobEvent(token, job, {
        level:
          attempt.status === 'SPOOL_COMPLETED'
            ? 'INFO'
            : attempt.status === 'FAILED'
              ? 'ERROR'
              : 'WARN',
        stage: `LOCAL_${attempt.status}`,
        code: attempt.errorCode,
        message: attempt.errorMessage,
        metadata: {
          localJobId: attempt.localJobId,
          attemptId: attempt.attemptId,
          copyNumber: attempt.copyNumber,
          copies: result.copies,
          transport: attempt.transport,
          printerName: attempt.printerName,
          windowsJobId: attempt.systemJobId,
          payloadBytes: attempt.payloadBytes,
          retrySafety: attempt.retrySafety,
          windowsStatus: attempt.lastWindowsStatus,
          windowsStatusNumber: attempt.lastWindowsStatusNumber,
          elapsedMs: attempt.elapsedMs,
        },
      });
    }
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
          metadata: { ...metadata, ackAttempt: attempt },
        });
        this.recordSuccessfulContact();
        return true;
      } catch (error) {
        if (error instanceof BackendAgentAuthExpiredError) {
          throw error;
        }
        lastError = error;
      }
    }

    this.recordBackendError(this.errorMessage(lastError));
    await this.recordPrintJobEvent(token, job, {
      level: 'WARN',
      stage: 'BACKEND_ACK_FAILED',
      code: 'BACKEND_ACK_FAILED',
      message:
        'Windows completo el ciclo observable del spooler, pero el backend no confirmo PRINTED. No se reporta FAILED para evitar duplicados.',
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
    const errorMessage = this.errorMessage(error);
    const errorCode = options.code ?? this.mapPrintError(error);
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
        body: { errorCode, errorMessage },
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
      this.dependencies.logger.warn(
        'No fue posible registrar evento de impresion en backend.',
        {
          backendJobId: job.id,
          stage: event.stage,
          error: this.errorMessage(error),
        },
      );
    });
  }

  private async request<T>(
    baseUrl: string,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
    token: string | null,
  ): Promise<T> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      BACKEND_REQUEST_TIMEOUT_MS,
    );

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
      const backendMessage = await this.parseBackendErrorResponse(response, path);

      if (token && (response.status === 401 || response.status === 403)) {
        this.handleBackendAuthenticationExpired(response.status);
        throw new BackendAgentAuthExpiredError(response.status);
      }

      throw new Error(backendMessage);
    }

    this.recordSuccessfulContact();
    return this.parseJsonResponse<T>(response, path);
  }

  private async parseJsonResponse<T>(response: Response, path: string): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    if (typeof response.text !== 'function') {
      return response.json() as Promise<T>;
    }

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

  private async parseBackendErrorResponse(
    response: Response,
    path: string,
  ): Promise<string> {
    const fallback = `Backend respondio ${response.status} en ${path}.`;

    try {
      let payload: unknown;

      if (typeof response.text === 'function') {
        const rawBody = (await response.text()).trim();
        if (!rawBody) {
          return fallback;
        }

        try {
          payload = JSON.parse(rawBody);
        } catch {
          return `${fallback} ${this.previewResponseBody(rawBody)}`;
        }
      } else if (typeof response.json === 'function') {
        payload = await response.json();
      }

      if (payload && typeof payload === 'object' && 'message' in payload) {
        const message = (payload as { message?: unknown }).message;

        if (typeof message === 'string' && message.trim()) {
          return message.trim();
        }
        if (Array.isArray(message) && message.length > 0) {
          return message.map((entry) => String(entry)).join(' ');
        }
      }
    } catch {
      return fallback;
    }

    return fallback;
  }

  private previewResponseBody(value: string): string {
    const normalizedValue = value.replace(/\s+/g, ' ').trim();
    return normalizedValue.length > 160
      ? `${normalizedValue.slice(0, 160)}...`
      : normalizedValue || '<vacio>';
  }

  private handleBackendAuthenticationExpired(statusCode: 401 | 403): void {
    if (this.authExpiredHandled) {
      return;
    }

    this.authExpiredHandled = true;
    this.stop();
    this.dependencies.configService.saveConfig({ backendDeviceToken: null });
    this.dependencies.logger.warn(
      'Sesion del agente expirada o revocada. Se requiere nuevo pairing.',
      { statusCode },
    );
    this.dependencies.notify?.(
      'Gestion al Dia Print Agent',
      'Sesion expirada. Realiza el pairing nuevamente.',
    );
  }

  private resolveBaseUrl(): string {
    return (
      this.dependencies.configService.getConfig().backendBaseUrl ||
      DEFAULT_BACKEND_BASE_URL
    );
  }

  private resolveDeviceName(): string {
    return (
      process.env.COMPUTERNAME ||
      process.env.HOSTNAME ||
      'Gestion al Dia Print Agent'
    );
  }

  private resolveDeviceId(): string {
    const config = this.dependencies.configService.getConfig();

    if (config.backendDeviceId) {
      return config.backendDeviceId;
    }

    const deviceId = crypto.randomUUID();
    this.dependencies.configService.saveConfig({ backendDeviceId: deviceId });
    return deviceId;
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
    this.lastErrorSnapshot = {
      at: new Date().toISOString(),
      message: message.trim() || 'Ocurrio un error de comunicacion con el backend.',
    };
  }
}
