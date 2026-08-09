import { LoggerService } from '../../logs/logger.service';
import {
  PrintTransport,
  PrintTransportJobStatus,
  SubmittedPrintJob,
} from '../contracts/print-transport';

export interface SpoolJobMonitorOptions {
  pollIntervalMs: number;
  completionTimeoutMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class SpoolJobMonitorService {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly logger: LoggerService,
    private readonly options: SpoolJobMonitorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
  }

  async monitor(
    job: SubmittedPrintJob,
    transport: PrintTransport,
    options: {
      previouslyObserved?: boolean;
      onStatus?: (status: PrintTransportJobStatus, elapsedMs: number) => void;
    } = {},
  ): Promise<PrintTransportJobStatus> {
    if (!job.systemJobId) {
      const status = await transport.getJobStatus(job);
      options.onStatus?.(status, 0);
      return {
        ...status,
        state: 'UNKNOWN',
        retrySafety: 'UNSAFE_TO_RETRY',
      };
    }

    const startedAt = this.now();
    let observed = options.previouslyObserved === true;
    let lastStatus: PrintTransportJobStatus | null = null;

    while (this.now() - startedAt <= this.options.completionTimeoutMs) {
      const elapsedMs = Math.max(0, this.now() - startedAt);
      const status = await transport.getJobStatus(job);
      lastStatus = status;

      if (status.exists === true || status.observed) {
        observed = true;
      }

      options.onStatus?.({ ...status, observed }, elapsedMs);

      if (status.exists === false && observed) {
        return {
          state: 'SPOOL_COMPLETED',
          exists: false,
          observed: true,
          code: 'WINDOWS_JOB_DISAPPEARED_AFTER_OBSERVATION',
          message:
            'Windows dejo de mostrar el trabajo despues de haber sido observado en el spooler.',
          retrySafety: 'UNSAFE_TO_RETRY',
        };
      }

      if (
        status.state === 'SPOOL_COMPLETED' ||
        status.state === 'FAILED' ||
        status.state === 'STUCK' ||
        status.state === 'CANCELLED'
      ) {
        return { ...status, observed };
      }

      await this.sleep(this.options.pollIntervalMs);
    }

    if (observed && lastStatus?.exists !== false) {
      this.logger.warn('Trabajo excedio el tiempo maximo en el spooler.', {
        printerName: job.printerName,
        systemJobId: job.systemJobId,
        documentName: job.documentName,
      });
      return {
        ...(lastStatus ?? {
          state: 'PRINTING',
          retrySafety: 'UNSAFE_TO_RETRY' as const,
        }),
        state: 'STUCK',
        observed: true,
        code: 'SPOOL_MONITOR_TIMEOUT',
        message: `Windows mantuvo el trabajo pendiente por mas de ${this.options.completionTimeoutMs} ms.`,
        retrySafety: 'UNSAFE_TO_RETRY',
      };
    }

    return {
      ...(lastStatus ?? {
        state: 'UNKNOWN',
        retrySafety: 'UNSAFE_TO_RETRY' as const,
      }),
      state: 'UNKNOWN',
      observed: false,
      code: lastStatus?.code ?? 'SPOOL_RESULT_UNKNOWN',
      message:
        lastStatus?.message ??
        'No fue posible observar el trabajo en Windows dentro del tiempo limite.',
      retrySafety: 'UNSAFE_TO_RETRY',
    };
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref?.();
  });
}

