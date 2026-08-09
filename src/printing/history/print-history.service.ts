import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LoggerService } from '../../logs/logger.service';
import { PrintJobRecord } from '../contracts/print-result';
import { PrintLifecycleStatus } from '../contracts/print-transport';

const MAX_STORED_JOBS = 500;
const RECOVERABLE_STATUSES = new Set<PrintLifecycleStatus>([
  'QUEUED',
  'FORMATTING',
  'READY',
  'SUBMITTING',
  'SUBMITTED',
  'SPOOLING',
  'PRINTING',
  'STUCK',
  'UNKNOWN',
]);

export type CreatePrintHistoryRecord = Omit<
  PrintJobRecord,
  'localJobId' | 'attemptId' | 'createdAt' | 'updatedAt' | 'status'
> & {
  status?: PrintLifecycleStatus;
};

export class PrintHistoryService {
  private readonly historyPath: string;
  private readonly temporaryPath: string;
  private readonly backupPath: string;
  private jobs: PrintJobRecord[];

  constructor(
    basePath: string,
    private readonly logger: LoggerService,
  ) {
    fs.mkdirSync(basePath, { recursive: true });
    this.historyPath = path.join(basePath, 'print-history.json');
    this.temporaryPath = path.join(basePath, 'print-history.tmp');
    this.backupPath = path.join(basePath, 'print-history.bak');
    this.jobs = this.loadFromDisk();
  }

  createJob(input: CreatePrintHistoryRecord): PrintJobRecord {
    const timestamp = new Date().toISOString();
    const localJobId = crypto.randomUUID();
    const job: PrintJobRecord = {
      ...input,
      localJobId,
      attemptId: localJobId,
      status: input.status ?? 'QUEUED',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.jobs = [job, ...this.jobs].slice(0, MAX_STORED_JOBS);
    this.persist();
    return { ...job };
  }

  updateJob(
    localJobId: string,
    patch: Partial<Omit<PrintJobRecord, 'localJobId' | 'attemptId' | 'createdAt'>>,
  ): PrintJobRecord {
    const jobIndex = this.jobs.findIndex((job) => job.localJobId === localJobId);

    if (jobIndex < 0) {
      throw new Error(`No existe el trabajo local ${localJobId} en el historial.`);
    }

    const timestamp = new Date().toISOString();
    const updated: PrintJobRecord = {
      ...this.jobs[jobIndex],
      ...patch,
      updatedAt: timestamp,
    };
    this.jobs = this.jobs.map((job, index) =>
      index === jobIndex ? updated : job,
    );

    this.persist();
    return { ...updated };
  }

  /** Compatibilidad temporal para consumidores migrados en la misma version. */
  recordQueued(label: string, printerName: string): string {
    return this.createJob({
      printerName,
      documentName: label,
      jobType: 'LEGACY_LOCAL',
      copyNumber: 1,
      copies: 1,
      transport: 'WINDOWS_RAW',
      retrySafety: 'SAFE_TO_RETRY',
    }).localJobId;
  }

  markProcessing(localJobId: string): void {
    this.updateJob(localJobId, { status: 'SUBMITTING' });
  }

  markCompleted(localJobId: string): void {
    this.updateJob(localJobId, {
      status: 'UNKNOWN',
      errorCode: 'LEGACY_COMPLETION_UNVERIFIED',
      errorMessage:
        'El flujo anterior no conservaba Windows JobId; no se confirma salida fisica.',
      retrySafety: 'UNSAFE_TO_RETRY',
    });
  }

  markFailed(localJobId: string, error: unknown): void {
    this.updateJob(localJobId, {
      status: 'FAILED',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  getJob(localJobId: string): PrintJobRecord | null {
    const job = this.jobs.find((candidate) => candidate.localJobId === localJobId);
    return job ? { ...job } : null;
  }

  getRecentJobs(limit = 50): PrintJobRecord[] {
    return this.jobs
      .slice(0, Math.max(1, Math.trunc(limit)))
      .map((job) => ({ ...job }));
  }

  getRecoverableJobs(): PrintJobRecord[] {
    return this.jobs
      .filter((job) => RECOVERABLE_STATUSES.has(job.status))
      .map((job) => ({ ...job }));
  }

  getLatestForPrinter(printerName: string): PrintJobRecord | null {
    const normalized = printerName.trim().toLocaleLowerCase();
    const job = this.jobs.find(
      (candidate) => candidate.printerName.toLocaleLowerCase() === normalized,
    );
    return job ? { ...job } : null;
  }

  private loadFromDisk(): PrintJobRecord[] {
    const candidates = [this.historyPath, this.backupPath].filter((sourcePath) =>
      fs.existsSync(sourcePath),
    );

    for (const sourcePath of candidates) {
      try {
        const parsedValue = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

        if (!Array.isArray(parsedValue)) {
          throw new Error('El historial persistido no contiene un arreglo JSON.');
        }

        return parsedValue
          .map(normalizeStoredJob)
          .filter((entry): entry is PrintJobRecord => entry !== null)
          .slice(0, MAX_STORED_JOBS);
      } catch (error) {
        this.logger.warn('No fue posible leer una copia del historial de impresion.', {
          sourcePath,
          error,
        });
      }
    }

    return [];
  }

  private persist(): void {
    const serialized = `${JSON.stringify(this.jobs, null, 2)}\n`;
    const fileDescriptor = fs.openSync(this.temporaryPath, 'w');

    try {
      fs.writeFileSync(fileDescriptor, serialized, 'utf8');
      fs.fsyncSync(fileDescriptor);
    } finally {
      fs.closeSync(fileDescriptor);
    }

    if (fs.existsSync(this.historyPath)) {
      fs.copyFileSync(this.historyPath, this.backupPath);
    }

    fs.renameSync(this.temporaryPath, this.historyPath);
  }
}

function normalizeStoredJob(value: unknown): PrintJobRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.localJobId === 'string') {
    return isCurrentPrintJob(value) ? (value as unknown as PrintJobRecord) : null;
  }

  return migrateLegacyPrintJob(value);
}

function isCurrentPrintJob(value: Record<string, unknown>): boolean {
  return (
    typeof value.localJobId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.printerName === 'string' &&
    typeof value.documentName === 'string' &&
    typeof value.jobType === 'string' &&
    typeof value.copyNumber === 'number' &&
    typeof value.copies === 'number' &&
    (value.transport === 'WINDOWS_RAW' || value.transport === 'WINDOWS_DRIVER') &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.retrySafety === 'SAFE_TO_RETRY' ||
      value.retrySafety === 'UNSAFE_TO_RETRY')
  );
}

function migrateLegacyPrintJob(value: Record<string, unknown>): PrintJobRecord | null {
  if (
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.printerName !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }

  const status: PrintLifecycleStatus =
    value.status === 'queued'
      ? 'QUEUED'
      : value.status === 'failed'
        ? 'FAILED'
        : 'UNKNOWN';

  return {
    localJobId: value.id,
    attemptId: value.id,
    printerName: value.printerName,
    documentName: value.label,
    jobType: 'LEGACY',
    copyNumber: 1,
    copies: 1,
    transport: 'WINDOWS_RAW',
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    errorCode: status === 'UNKNOWN' ? 'LEGACY_COMPLETION_UNVERIFIED' : undefined,
    errorMessage:
      typeof value.errorMessage === 'string'
        ? value.errorMessage
        : status === 'UNKNOWN'
          ? 'El historial anterior no conservaba Windows JobId ni confirmacion del spooler.'
          : undefined,
    retrySafety: 'UNSAFE_TO_RETRY',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
