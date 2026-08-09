import { LoggerService } from '../../logs/logger.service';

export type PrinterQueueHealth = 'HEALTHY' | 'BLOCKED';

export interface PrinterQueueSnapshot {
  printerName: string;
  pendingJobs: number;
  isProcessing: boolean;
  activeJobLabel?: string;
  health: PrinterQueueHealth;
  blockedAt?: string;
  blockedByLocalJobId?: string;
  blockReason?: string;
}

interface PrinterQueueState {
  printerName: string;
  chain: Promise<void>;
  pendingJobs: number;
  activeJobLabel: string | null;
  blockedAt: string | null;
  blockedByLocalJobId: string | null;
  blockReason: string | null;
}

export class PrinterQueueBlockedError extends Error {
  constructor(readonly printerName: string, message: string) {
    super(message);
    this.name = 'PrinterQueueBlockedError';
  }
}

export class PrinterQueueBackpressureError extends Error {
  constructor(readonly printerName: string, readonly limit: number) {
    super(
      `La cola local de la impresora "${printerName}" alcanzo el limite de ${limit} trabajos.`,
    );
    this.name = 'PrinterQueueBackpressureError';
  }
}

export class PrinterQueueService {
  private readonly queues = new Map<string, PrinterQueueState>();

  constructor(
    private readonly logger: LoggerService,
    private readonly maxPendingPerPrinter = 50,
  ) {}

  enqueue<T>(
    printerName: string,
    label: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const state = this.getOrCreateState(printerName);
    this.assertAccepting(printerName, state);

    if (state.pendingJobs >= this.maxPendingPerPrinter) {
      throw new PrinterQueueBackpressureError(printerName, this.maxPendingPerPrinter);
    }

    state.pendingJobs += 1;

    const runTask = state.chain.then(async () => {
      this.assertAccepting(printerName, state);
      state.activeJobLabel = label;
      this.logger.info('Procesando trabajo en cola de impresora.', {
        printerName,
        label,
      });

      return task();
    });

    state.chain = runTask.then(
      () => undefined,
      (error) => {
        this.logger.error('El trabajo de la cola de impresora fallo.', {
          printerName,
          label,
          error,
        });
      },
    ).finally(() => {
      state.pendingJobs = Math.max(0, state.pendingJobs - 1);
      if (state.activeJobLabel === label) {
        state.activeJobLabel = null;
      }
    });

    return runTask;
  }

  blockPrinter(printerName: string, localJobId: string, reason: string): void {
    const state = this.getOrCreateState(printerName);
    state.blockedAt = new Date().toISOString();
    state.blockedByLocalJobId = localJobId;
    state.blockReason = reason;
    this.logger.warn('Impresora bloqueada para evitar trabajos duplicados.', {
      printerName,
      localJobId,
      reason,
    });
  }

  unblockPrinter(printerName: string): void {
    const state = this.getOrCreateState(printerName);
    state.blockedAt = null;
    state.blockedByLocalJobId = null;
    state.blockReason = null;
    this.logger.info('Impresora desbloqueada manualmente.', { printerName });
  }

  unblockPrinterIfBlockedBy(printerName: string, localJobId: string): boolean {
    const state = this.getOrCreateState(printerName);

    if (state.blockedByLocalJobId !== localJobId) {
      return false;
    }

    state.blockedAt = null;
    state.blockedByLocalJobId = null;
    state.blockReason = null;
    this.logger.info('Impresora desbloqueada al resolver el trabajo que abrio el circuito.', {
      printerName,
      localJobId,
    });
    return true;
  }

  isBlocked(printerName: string): boolean {
    return this.getOrCreateState(printerName).blockedAt !== null;
  }

  getPrinterSnapshot(printerName: string): PrinterQueueSnapshot {
    return this.toSnapshot(printerName, this.getOrCreateState(printerName));
  }

  getSnapshot(): {
    pendingJobs: number;
    isProcessing: boolean;
    activeJobLabel?: string;
    printers: PrinterQueueSnapshot[];
  } {
    const printers = Array.from(this.queues.values()).map((state) =>
      this.toSnapshot(state.printerName, state),
    );
    const activeJobs = printers
      .map((printer) => printer.activeJobLabel)
      .filter((label): label is string => Boolean(label));

    return {
      pendingJobs: printers.reduce((total, printer) => total + printer.pendingJobs, 0),
      isProcessing: activeJobs.length > 0,
      activeJobLabel: activeJobs[0],
      printers,
    };
  }

  private getOrCreateState(printerName: string): PrinterQueueState {
    const key = normalizePrinterKey(printerName);
    const current = this.queues.get(key);

    if (current) {
      return current;
    }

    const state: PrinterQueueState = {
      printerName: printerName.trim(),
      chain: Promise.resolve(),
      pendingJobs: 0,
      activeJobLabel: null,
      blockedAt: null,
      blockedByLocalJobId: null,
      blockReason: null,
    };
    this.queues.set(key, state);
    return state;
  }

  private assertAccepting(printerName: string, state: PrinterQueueState): void {
    if (!state.blockedAt) {
      return;
    }

    throw new PrinterQueueBlockedError(
      printerName,
      state.blockReason ??
        `La impresora ${printerName} esta bloqueada por un trabajo sin resolver.`,
    );
  }

  private toSnapshot(
    printerName: string,
    state: PrinterQueueState,
  ): PrinterQueueSnapshot {
    return {
      printerName,
      pendingJobs: state.pendingJobs,
      isProcessing: state.activeJobLabel !== null,
      activeJobLabel: state.activeJobLabel ?? undefined,
      health: state.blockedAt ? 'BLOCKED' : 'HEALTHY',
      blockedAt: state.blockedAt ?? undefined,
      blockedByLocalJobId: state.blockedByLocalJobId ?? undefined,
      blockReason: state.blockReason ?? undefined,
    };
  }
}

function normalizePrinterKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();

  if (!normalized) {
    throw new Error('El nombre de impresora es obligatorio para encolar.');
  }

  return normalized;
}
