import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LoggerService } from '../logs/logger.service';
import { PrintJobRecord } from '../shared/contracts';

const MAX_STORED_JOBS = 200;

export class PrintHistoryService {
  private readonly historyPath: string;
  private jobs: PrintJobRecord[];

  constructor(
    basePath: string,
    private readonly logger: LoggerService,
  ) {
    fs.mkdirSync(basePath, { recursive: true });
    this.historyPath = path.join(basePath, 'print-history.json');
    this.jobs = this.loadFromDisk();
  }

  recordQueued(label: string, printerName: string): string {
    const timestamp = new Date().toISOString();
    const job: PrintJobRecord = {
      id: crypto.randomUUID(),
      label,
      printerName,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.jobs = [job, ...this.jobs].slice(0, MAX_STORED_JOBS);
    this.persist();
    return job.id;
  }

  markProcessing(jobId: string): void {
    this.updateJob(jobId, {
      status: 'processing',
    });
  }

  markCompleted(jobId: string): void {
    this.updateJob(jobId, {
      status: 'completed',
      errorMessage: undefined,
    });
  }

  markFailed(jobId: string, error: unknown): void {
    this.updateJob(jobId, {
      status: 'failed',
      errorMessage:
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Ocurrio un error inesperado al imprimir.',
    });
  }

  getRecentJobs(limit = 50): PrintJobRecord[] {
    return this.jobs.slice(0, Math.max(1, Math.trunc(limit)));
  }

  private updateJob(
    jobId: string,
    patch: Partial<Pick<PrintJobRecord, 'status' | 'errorMessage'>>,
  ): void {
    const nextJobs = this.jobs.map((job) =>
      job.id === jobId
        ? {
            ...job,
            ...patch,
            updatedAt: new Date().toISOString(),
          }
        : job,
    );

    this.jobs = nextJobs;
    this.persist();
  }

  private loadFromDisk(): PrintJobRecord[] {
    if (!fs.existsSync(this.historyPath)) {
      return [];
    }

    try {
      const rawValue = fs.readFileSync(this.historyPath, 'utf8');
      const parsedValue = JSON.parse(rawValue);

      if (!Array.isArray(parsedValue)) {
        return [];
      }

      return parsedValue
        .filter((entry): entry is PrintJobRecord => isPrintJobRecord(entry))
        .slice(0, MAX_STORED_JOBS);
    } catch (error) {
      this.logger.warn(
        'No fue posible leer el historial de impresion. Se inicia uno nuevo.',
        error,
      );
      return [];
    }
  }

  private persist(): void {
    fs.writeFileSync(this.historyPath, `${JSON.stringify(this.jobs, null, 2)}\n`, 'utf8');
  }
}

function isPrintJobRecord(value: unknown): value is PrintJobRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    typeof record.printerName === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.status === 'queued' ||
      record.status === 'processing' ||
      record.status === 'completed' ||
      record.status === 'failed') &&
    (typeof record.errorMessage === 'string' || typeof record.errorMessage === 'undefined')
  );
}
