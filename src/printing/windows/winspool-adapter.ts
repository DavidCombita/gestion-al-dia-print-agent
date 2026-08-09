import crypto from 'node:crypto';
import path from 'node:path';
import { app, utilityProcess, UtilityProcess } from 'electron';
import { LoggerService } from '../../logs/logger.service';

export interface NativePrinterSnapshot {
  name?: string;
  printerName?: string;
  isDefault?: boolean;
  status?: string | string[];
  statusNumber?: number;
}

export interface NativeWindowsJobSnapshot {
  id: number;
  document?: string;
  status?: string | string[];
  statusNumber?: number;
  size?: number;
  totalPages?: number;
}

export interface WinSpoolRuntimeInfo {
  printerModulePath: string;
  printerBinaryPath?: string;
  printerPackageVersion?: string;
  printerModuleMode: 'package-wrapper';
  helperPid?: number;
}

interface WinSpoolAdapterOptions {
  printerModulePath?: string;
  requestTimeoutMs?: number;
  submitTimeoutMs?: number;
}

interface HelperRequest {
  requestId: string;
  action: string;
  payload?: Record<string, unknown>;
}

interface HelperResponse {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    outcomeUnknown?: boolean;
  };
}

interface PendingRequest {
  action: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class WinSpoolOperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly action: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'WinSpoolOperationError';
  }
}

export class WinSpoolAdapter {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly printerModulePath: string;
  private readonly requestTimeoutMs: number;
  private readonly submitTimeoutMs: number;
  private helper: UtilityProcess | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private isStopping = false;
  private isDisposed = false;

  constructor(
    private readonly logger: LoggerService,
    options: WinSpoolAdapterOptions = {},
  ) {
    this.printerModulePath =
      options.printerModulePath ?? resolvePrinterModulePath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.submitTimeoutMs = options.submitTimeoutMs ?? 20_000;
  }

  async initialize(): Promise<WinSpoolRuntimeInfo> {
    return this.request<WinSpoolRuntimeInfo>('runtimeInfo');
  }

  async listPrinters(): Promise<NativePrinterSnapshot[]> {
    return this.request<NativePrinterSnapshot[]>('listPrinters');
  }

  async submitRaw(input: {
    printerName: string;
    documentName: string;
    data: Buffer;
  }): Promise<number> {
    return this.request<number>(
      'submitRaw',
      {
        printerName: input.printerName,
        documentName: input.documentName,
        dataBase64: input.data.toString('base64'),
      },
      this.submitTimeoutMs,
    );
  }

  async getJob(
    printerName: string,
    systemJobId: number,
  ): Promise<NativeWindowsJobSnapshot | null> {
    return this.request<NativeWindowsJobSnapshot | null>('getJob', {
      printerName,
      systemJobId,
    });
  }

  async listJobs(printerName: string): Promise<NativeWindowsJobSnapshot[]> {
    return this.request<NativeWindowsJobSnapshot[]>('listJobs', { printerName });
  }

  async deleteJob(printerName: string, systemJobId: number): Promise<void> {
    await this.request('deleteJob', { printerName, systemJobId });
  }

  dispose(): void {
    this.isDisposed = true;
    this.isStopping = true;
    this.terminateHelper(
      new WinSpoolOperationError(
        'El helper WinSpool se detuvo durante el cierre del agente.',
        'WINSPOOL_HELPER_STOPPED',
        'dispose',
      ),
    );
  }

  private request<T>(
    action: string,
    payload?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (process.platform !== 'win32') {
      return Promise.reject(
        new WinSpoolOperationError(
          'WinSpool solo esta disponible en Windows.',
          'WINDOWS_ONLY',
          action,
        ),
      );
    }

    if (this.isDisposed) {
      return Promise.reject(
        new WinSpoolOperationError(
          'El adapter WinSpool ya fue liberado.',
          'WINSPOOL_ADAPTER_DISPOSED',
          action,
        ),
      );
    }

    const operation = this.operationChain.then(() =>
      this.dispatchRequest<T>(action, payload, timeoutMs),
    );
    this.operationChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private dispatchRequest<T>(
    action: string,
    payload: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.reject(
        new WinSpoolOperationError(
          'El adapter WinSpool ya fue liberado.',
          'WINSPOOL_ADAPTER_DISPOSED',
          action,
        ),
      );
    }

    const helper = this.ensureHelper();
    const requestId = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId);

        if (!pending) {
          return;
        }

        this.pending.delete(requestId);
        const error = new WinSpoolOperationError(
          `La operacion WinSpool ${action} excedio ${timeoutMs} ms.`,
          action === 'submitRaw'
            ? 'SUBMIT_TIMEOUT_UNKNOWN'
            : 'WINSPOOL_OPERATION_TIMEOUT',
          action,
          action === 'submitRaw',
        );
        pending.reject(error);
        this.terminateHelper(error);
      }, timeoutMs);

      this.pending.set(requestId, {
        action,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        helper.postMessage({ requestId, action, payload } satisfies HelperRequest);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureHelper(): UtilityProcess {
    if (this.helper?.pid) {
      return this.helper;
    }

    this.isStopping = false;
    const helperPath = path.join(__dirname, 'winspool-helper.js');
    const helper = utilityProcess.fork(helperPath, [this.printerModulePath], {
      serviceName: 'Gestion al Dia WinSpool',
      stdio: 'pipe',
    });
    this.helper = helper;

    helper.on('message', (message: unknown) => {
      this.handleHelperMessage(message);
    });
    helper.on('exit', (code) => {
      if (this.helper === helper) {
        this.helper = null;
      }

      const error = new WinSpoolOperationError(
        `El helper WinSpool termino con codigo ${code}.`,
        'WINSPOOL_HELPER_EXITED',
        'helper',
      );
      this.rejectAllPending(error);

      if (!this.isStopping) {
        this.logger.error('El helper WinSpool termino inesperadamente.', {
          code,
          printerModulePath: this.printerModulePath,
        });
      }
    });
    helper.stderr?.on('data', (chunk) => {
      this.logger.warn('Salida de error del helper WinSpool.', {
        message: Buffer.from(chunk).toString('utf8').trim(),
      });
    });

    return helper;
  }

  private handleHelperMessage(message: unknown): void {
    if (!isHelperResponse(message)) {
      this.logger.warn('El helper WinSpool envio una respuesta invalida.');
      return;
    }

    const pending = this.pending.get(message.requestId);

    if (!pending) {
      return;
    }

    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);

    if (message.success) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(
      new WinSpoolOperationError(
        message.error?.message ?? `Fallo la operacion WinSpool ${pending.action}.`,
        message.error?.code ?? 'WINSPOOL_OPERATION_FAILED',
        pending.action,
        message.error?.outcomeUnknown === true,
      ),
    );
  }

  private terminateHelper(error: Error): void {
    const helper = this.helper;
    this.helper = null;
    this.rejectAllPending(error);

    if (helper?.pid) {
      helper.kill();
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resolvePrinterModulePath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'printer-runtime',
      'lib',
      'printer.js',
    );
  }

  return require.resolve('printer');
}

function isHelperResponse(value: unknown): value is HelperResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as HelperResponse).requestId === 'string' &&
      typeof (value as HelperResponse).success === 'boolean',
  );
}
