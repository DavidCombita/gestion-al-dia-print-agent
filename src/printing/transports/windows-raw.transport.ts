import {
  PrintTransport,
  PrintTransportError,
  PrintTransportJobStatus,
  PrintTransportRequest,
  SubmittedPrintJob,
} from '../contracts/print-transport';
import { mapWindowsJobStatus } from '../windows/windows-print-status.mapper';
import {
  WinSpoolAdapter,
  WinSpoolOperationError,
} from '../windows/winspool-adapter';

export class WindowsRawTransport implements PrintTransport {
  readonly type = 'WINDOWS_RAW' as const;

  constructor(private readonly adapter: WinSpoolAdapter) {}

  async submit(request: PrintTransportRequest): Promise<SubmittedPrintJob> {
    if (!request.rawData?.length) {
      throw new PrintTransportError(
        'El transporte RAW recibio un documento vacio.',
        'RAW_DOCUMENT_EMPTY',
        'SAFE_TO_RETRY',
        false,
      );
    }

    try {
      const systemJobId = await this.adapter.submitRaw({
        printerName: request.printer.systemName,
        documentName: request.documentName,
        data: request.rawData,
      });

      return {
        transport: this.type,
        printerName: request.printer.systemName,
        documentName: request.documentName,
        systemJobId,
        submittedAt: new Date().toISOString(),
        payloadBytes: request.payloadBytes,
      };
    } catch (error) {
      const operationError =
        error instanceof WinSpoolOperationError ? error : null;
      throw new PrintTransportError(
        error instanceof Error ? error.message : String(error),
        operationError?.code ?? 'RAW_SUBMIT_FAILED',
        operationError?.outcomeUnknown
          ? 'UNSAFE_TO_RETRY'
          : 'SAFE_TO_RETRY',
        operationError?.outcomeUnknown === true,
      );
    }
  }

  async getJobStatus(job: SubmittedPrintJob): Promise<PrintTransportJobStatus> {
    if (!job.systemJobId) {
      return {
        state: 'UNKNOWN',
        observed: false,
        code: 'WINDOWS_JOB_ID_MISSING',
        message: 'No se conservo el Windows JobId del trabajo RAW.',
        retrySafety: 'UNSAFE_TO_RETRY',
      };
    }

    try {
      const snapshot = await this.adapter.getJob(job.printerName, job.systemJobId);

      if (!snapshot) {
        return {
          state: 'UNKNOWN',
          exists: false,
          observed: false,
          code: 'WINDOWS_JOB_NOT_FOUND',
          retrySafety: 'UNSAFE_TO_RETRY',
        };
      }

      return mapWindowsJobStatus(snapshot);
    } catch (error) {
      return {
        state: 'UNKNOWN',
        observed: false,
        code:
          error instanceof WinSpoolOperationError
            ? error.code
            : 'WINDOWS_JOB_QUERY_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retrySafety: 'UNSAFE_TO_RETRY',
      };
    }
  }

  async cancel(job: SubmittedPrintJob): Promise<void> {
    if (!job.systemJobId) {
      throw new Error('No se puede cancelar un trabajo sin Windows JobId.');
    }

    await this.adapter.deleteJob(job.printerName, job.systemJobId);
  }

  async healthCheck(printer: { systemName: string }): Promise<{ available: boolean }> {
    const printers = await this.adapter.listPrinters();
    const normalized = printer.systemName.trim().toLocaleLowerCase();
    return {
      available: printers.some((candidate) => {
        const name = candidate.name ?? candidate.printerName ?? '';
        return name.trim().toLocaleLowerCase() === normalized;
      }),
    };
  }

  dispose(): void {
    this.adapter.dispose();
  }
}

