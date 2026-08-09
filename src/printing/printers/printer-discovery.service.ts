import { LoggerService } from '../../logs/logger.service';
import { PrinterDescriptor } from '../../shared/contracts';
import { mapWindowsPrinterAvailability } from '../windows/windows-print-status.mapper';
import { WinSpoolAdapter } from '../windows/winspool-adapter';

export class PrinterDiscoveryService {
  constructor(
    private readonly adapter: WinSpoolAdapter,
    private readonly logger: LoggerService,
  ) {}

  async listPrinters(): Promise<PrinterDescriptor[]> {
    const printers = await this.adapter.listPrinters();

    return printers.map((printer) => {
      const name =
        (typeof printer.name === 'string' && printer.name.trim()) ||
        (typeof printer.printerName === 'string' && printer.printerName.trim()) ||
        'Impresora sin nombre';
      const availability = mapWindowsPrinterAvailability(printer);

      return {
        name,
        isDefault: printer.isDefault === true,
        status:
          availability === 'READY'
            ? 'ready'
            : availability === 'OFFLINE'
              ? 'offline'
              : availability === 'ERROR'
                ? 'error'
                : 'unknown',
      };
    });
  }

  async printerExists(systemName: string): Promise<boolean> {
    const normalized = systemName.trim().toLocaleLowerCase();
    return (await this.listPrinters()).some(
      (printer) => printer.name.toLocaleLowerCase() === normalized,
    );
  }

  async getModuleStatus(): Promise<{
    ready: boolean;
    error?: string;
    runtime?: Awaited<ReturnType<WinSpoolAdapter['initialize']>>;
  }> {
    try {
      return {
        ready: true,
        runtime: await this.adapter.initialize(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('No fue posible inicializar el adapter WinSpool.', { message });
      return { ready: false, error: message };
    }
  }
}

