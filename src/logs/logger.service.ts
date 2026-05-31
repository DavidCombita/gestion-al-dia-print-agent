import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';

export class LoggerService {
  readonly logFilePath: string;

  constructor(basePath: string) {
    const logsDirectory = path.join(basePath, 'logs');
    fs.mkdirSync(logsDirectory, { recursive: true });
    this.logFilePath = path.join(logsDirectory, 'print-agent.log');

    log.initialize();
    log.transports.file.resolvePathFn = () => this.logFilePath;
    log.transports.file.level = 'info';
  }

  info(message: string, context?: unknown): void {
    log.info(message, context ?? '');
  }

  warn(message: string, context?: unknown): void {
    log.warn(message, context ?? '');
  }

  error(message: string, context?: unknown): void {
    log.error(message, context ?? '');
  }
}
