import { io, Socket } from 'socket.io-client';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrintHistoryService } from '../printing/print-history.service';
import { PrintQueueService } from '../printing/print-queue.service';
import { PrinterService } from '../printing/printer.service';
import { formatInvoice } from '../printing/formatters/invoice.formatter';
import { formatKitchenOrder } from '../printing/formatters/kitchen-order.formatter';
import { formatTestTicket } from '../printing/formatters/test-ticket.formatter';
import { ReceiptJobPayload } from '../shared/contracts';

type BackendPrintJobStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'PRINTING'
  | 'PRINTED'
  | 'FAILED'
  | 'CANCELLED';

interface BackendPrintJob {
  id: string;
  type: 'KITCHEN_TICKET' | 'RECEIPT' | 'SHIFT_REPORT' | 'CASH_CLOSING' | 'TEST_PRINT';
  status: BackendPrintJobStatus;
  payload: ReceiptJobPayload;
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

export class BackendPrintClientService {
  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private authExpiredHandled = false;

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
      backendBaseUrl: null,
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
      this.dependencies.logger.info('Conectado al WebSocket de impresion backend.');
    });
    this.socket.on('connect_error', (error) => {
      this.dependencies.logger.warn('Fallo la autenticacion o conexion del WebSocket de impresion.', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.socket.on('print-job.created', () => {
      void this.processNextPending();
    });
    this.socket.on('disconnect', (reason) => {
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
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

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

      await this.printClaimedJob(claimedJob, token);
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        return;
      }

      this.dependencies.logger.warn('No fue posible procesar trabajos pendientes del backend.', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async printClaimedJob(job: BackendPrintJob, token: string): Promise<void> {
    const baseUrl = this.resolveBaseUrl();
    const printerName = job.printer.systemName || job.printer.name;
    const payload = this.normalizePayload(job);
    const copies = Math.max(1, Math.min(5, Math.trunc(payload.options?.copies ?? job.printer.copies ?? 1)));
    const buffer = this.formatJob(job.type, payload);

    await this.request(baseUrl, `/print-jobs/${encodeURIComponent(job.id)}/printing`, { method: 'POST' }, token);
    this.dependencies.logger.info('Trabajo marcado como imprimiendo en backend.', {
      jobId: job.id,
      printerName,
    });

    try {
      for (let index = 0; index < copies; index += 1) {
        const label = copies > 1 ? `${job.type}-${job.id}-${index + 1}` : `${job.type}-${job.id}`;
        const historyId = this.dependencies.printHistoryService.recordQueued(label, printerName);
        await this.dependencies.queueService.enqueue(label, async () => {
          this.dependencies.printHistoryService.markProcessing(historyId);
          await this.dependencies.printerService.printRaw(printerName, label, buffer);
          this.dependencies.printHistoryService.markCompleted(historyId);
        });
      }

      await this.request(baseUrl, `/print-jobs/${encodeURIComponent(job.id)}/printed`, { method: 'POST' }, token);
      this.dependencies.logger.info('Trabajo marcado como impreso en backend.', {
        jobId: job.id,
        printerName,
        copies,
      });
    } catch (error) {
      if (error instanceof BackendAgentAuthExpiredError) {
        throw error;
      }

      this.dependencies.logger.warn('Trabajo de impresion backend fallido.', {
        jobId: job.id,
        printerName,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.request(baseUrl, `/print-jobs/${encodeURIComponent(job.id)}/failed`, {
        method: 'POST',
        body: {
          errorCode: this.mapPrintError(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      }, token).catch(() => undefined);
    }
  }

  private normalizePayload(job: BackendPrintJob): ReceiptJobPayload {
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

  private formatJob(type: BackendPrintJob['type'], payload: ReceiptJobPayload): Buffer {
    if (type === 'KITCHEN_TICKET') {
      return formatKitchenOrder(payload);
    }

    if (type === 'TEST_PRINT') {
      return formatTestTicket(payload);
    }

    return formatInvoice(payload);
  }

  private async request<T>(
    baseUrl: string,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
    token: string | null,
  ): Promise<T> {
    const response = await fetch(new URL(path, baseUrl), {
      method: options.method,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.handleBackendAuthenticationExpired(response.status);
        throw new BackendAgentAuthExpiredError(response.status);
      }

      throw new Error(`Backend respondió ${response.status}`);
    }

    return (await response.json()) as T;
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
    return DEFAULT_BACKEND_BASE_URL;
  }

  private resolveDeviceName(): string {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || 'Gestion al Dia Print Agent';
  }

  private mapPrintError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

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
}
