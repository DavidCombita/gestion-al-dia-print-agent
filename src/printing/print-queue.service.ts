import { LoggerService } from '../logs/logger.service';

export class PrintQueueService {
  private chain = Promise.resolve();
  private pendingJobs = 0;
  private activeJobLabel: string | null = null;

  constructor(private readonly logger: LoggerService) {}

  enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.pendingJobs += 1;

    const runTask = this.chain.then(async () => {
      this.activeJobLabel = label;
      this.logger.info('Procesando trabajo de impresion.', { label });

      try {
        return await task();
      } finally {
        this.pendingJobs = Math.max(0, this.pendingJobs - 1);
        if (this.activeJobLabel === label) {
          this.activeJobLabel = null;
        }
      }
    });

    this.chain = runTask.then(
      () => undefined,
      (error) => {
        this.logger.error('El trabajo de impresion fallo.', { label, error });
      },
    );

    return runTask;
  }

  getSnapshot(): {
    pendingJobs: number;
    isProcessing: boolean;
    activeJobLabel?: string;
  } {
    return {
      pendingJobs: this.pendingJobs,
      isProcessing: this.activeJobLabel !== null,
      activeJobLabel: this.activeJobLabel ?? undefined,
    };
  }
}
