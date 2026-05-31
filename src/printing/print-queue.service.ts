import { LoggerService } from '../logs/logger.service';

export class PrintQueueService {
  private chain = Promise.resolve();

  constructor(private readonly logger: LoggerService) {}

  enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    const runTask = this.chain.then(async () => {
      this.logger.info('Procesando trabajo de impresion.', { label });
      return task();
    });

    this.chain = runTask.then(
      () => undefined,
      (error) => {
        this.logger.error('El trabajo de impresion fallo.', { label, error });
      },
    );

    return runTask;
  }
}
