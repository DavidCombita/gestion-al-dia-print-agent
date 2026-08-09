import { BrowserWindow } from 'electron';
import {
  PrintTransport,
  PrintTransportError,
  PrintTransportJobStatus,
  PrintTransportRequest,
  SubmittedPrintJob,
} from '../contracts/print-transport';

interface DriverWindow {
  loadURL(url: string): Promise<void>;
  webContents: {
    print(
      options: Electron.WebContentsPrintOptions & {
        usePrinterDefaultPageSize?: boolean;
      },
      callback: (success: boolean, failureReason: string) => void,
    ): void;
  };
  destroy(): void;
}

export type DriverWindowFactory = () => DriverWindow;

export class WindowsDriverTransport implements PrintTransport {
  readonly type = 'WINDOWS_DRIVER' as const;

  constructor(
    private readonly createWindow: DriverWindowFactory = () =>
      new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      }),
    private readonly printTimeoutMs = 30_000,
  ) {}

  async submit(request: PrintTransportRequest): Promise<SubmittedPrintJob> {
    if (!request.html?.trim()) {
      throw new PrintTransportError(
        'El transporte driver recibio un documento HTML vacio.',
        'DRIVER_DOCUMENT_EMPTY',
        'SAFE_TO_RETRY',
        false,
      );
    }

    const window = this.createWindow();

    try {
      const dataUrl = `data:text/html;base64,${Buffer.from(request.html, 'utf8').toString('base64')}`;
      await window.loadURL(dataUrl);
      await this.print(window, request);

      return {
        transport: this.type,
        printerName: request.printer.systemName,
        documentName: request.documentName,
        submittedAt: new Date().toISOString(),
        payloadBytes: request.payloadBytes,
      };
    } finally {
      window.destroy();
    }
  }

  async getJobStatus(_job: SubmittedPrintJob): Promise<PrintTransportJobStatus> {
    return {
      state: 'SPOOL_COMPLETED',
      observed: false,
      code: 'DRIVER_SUBMIT_ACCEPTED_NO_JOB_ID',
      message:
        'Electron confirmo que Windows acepto el trabajo. No hay JobId disponible, por lo que el agente lo da por completado y continua.',
      retrySafety: 'UNSAFE_TO_RETRY',
    };
  }

  private print(window: DriverWindow, request: PrintTransportRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        reject(
          new PrintTransportError(
            'Electron no confirmo el submit por driver dentro del tiempo limite.',
            'DRIVER_SUBMIT_TIMEOUT_UNKNOWN',
            'UNSAFE_TO_RETRY',
            true,
          ),
        );
      }, this.printTimeoutMs);

      window.webContents.print(
        {
          silent: true,
          deviceName: request.printer.systemName,
          printBackground: true,
          margins: { marginType: 'none' },
          usePrinterDefaultPageSize:
            request.driverOptions?.usePrinterDefaultPageSize !== false,
        },
        (success, failureReason) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeout);

          if (success) {
            resolve();
            return;
          }

          reject(
            new PrintTransportError(
              failureReason || 'Electron no pudo enviar el trabajo al driver.',
              'DRIVER_SUBMIT_FAILED',
              'SAFE_TO_RETRY',
              false,
            ),
          );
        },
      );
    });
  }
}
