import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrinterDescriptor } from '../shared/contracts';

interface PrintDirectOptions {
  data: Buffer;
  type: 'RAW';
  printer: string;
  docname: string;
  success: () => void;
  error: (error: unknown) => void;
}

type PrinterModule = {
  getPrinters: () => Array<{ name: string; isDefault?: boolean; status?: string }>;
  printDirect: (options: PrintDirectOptions) => void;
};

export class PrinterService {
  constructor(
    private readonly configService: AppConfigService,
    private readonly logger: LoggerService,
  ) {}

  async listPrinters(): Promise<PrinterDescriptor[]> {
    const printerModule = await this.loadPrinterModule();
    return printerModule.getPrinters().map((printer) => ({
      name: printer.name,
      isDefault: printer.isDefault === true,
      status: normalizePrinterStatus(printer.status),
    }));
  }

  async printRaw(
    targetPrinterName: string,
    documentName: string,
    payload: Buffer,
  ): Promise<void> {
    const printerModule = await this.loadPrinterModule();

    await new Promise<void>((resolve, reject) => {
      printerModule.printDirect({
        data: payload,
        type: 'RAW',
        printer: targetPrinterName,
        docname: documentName,
        success: () => {
          this.logger.info('Trabajo enviado a la impresora.', {
            targetPrinterName,
            documentName,
          });
          resolve();
        },
        error: (error) => {
          reject(new Error(typeof error === 'string' ? error : 'La impresion RAW fallo.'));
        },
      });
    });
  }

  resolvePrinterName(kind: 'invoice' | 'kitchen'): string {
    const config = this.configService.getConfig();
    const printerName =
      kind === 'invoice' ? config.invoicePrinterName : config.kitchenPrinterName;

    if (!printerName) {
      throw new Error(
        kind === 'invoice'
          ? 'Configura la impresora de facturas antes de imprimir.'
          : 'Configura la impresora de comandas antes de imprimir.',
      );
    }

    return printerName;
  }

  private async loadPrinterModule(): Promise<PrinterModule> {
    if (process.platform !== 'win32') {
      throw new Error('Gestion al Dia Print Agent solo soporta impresion directa en Windows.');
    }

    try {
      const printerModule = (await import('printer')) as unknown as PrinterModule;
      return printerModule;
    } catch (error) {
      this.logger.error('No fue posible cargar el modulo nativo de impresion.', error);
      throw new Error(
        'No fue posible cargar el modulo de impresion nativo. Ejecuta npm install en Windows y recompila el agente.',
      );
    }
  }
}

function normalizePrinterStatus(value: string | undefined): PrinterDescriptor['status'] {
  const normalizedValue = value?.trim().toLowerCase();

  if (normalizedValue === 'online' || normalizedValue === 'idle') {
    return 'ready';
  }

  if (normalizedValue === 'offline') {
    return 'offline';
  }

  return 'unknown';
}
