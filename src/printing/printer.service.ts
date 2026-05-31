import fs from 'node:fs';
import path from 'node:path';
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
  getPrinters: () => Array<{
    name?: string;
    printerName?: string;
    isDefault?: boolean;
    status?: string | string[];
    statusNumber?: number;
  }>;
  getDefaultPrinterName?: () => string;
  printDirect: (options: PrintDirectOptions) => void;
};

export class PrinterService {
  constructor(
    private readonly configService: AppConfigService,
    private readonly logger: LoggerService,
  ) {}

  async listPrinters(): Promise<PrinterDescriptor[]> {
    const printerModule = await this.loadPrinterModule();
    const defaultPrinterName = this.resolveDefaultPrinterName(printerModule);

    return printerModule.getPrinters().map((printer) => ({
      name: resolvePrinterDisplayName(printer),
      isDefault:
        printer.isDefault === true ||
        resolvePrinterDisplayName(printer) === defaultPrinterName,
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

  private resolveDefaultPrinterName(printerModule: PrinterModule): string | null {
    if (typeof printerModule.getDefaultPrinterName !== 'function') {
      return null;
    }

    try {
      const defaultPrinterName = printerModule.getDefaultPrinterName()?.trim();
      return defaultPrinterName || null;
    } catch {
      return null;
    }
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

  async getModuleStatus(): Promise<{ ready: boolean; error?: string }> {
    try {
      await this.loadPrinterModule();
      return {
        ready: true,
      };
    } catch (error) {
      return {
        ready: false,
        error:
          error instanceof Error && error.message.trim()
            ? error.message
            : 'No fue posible cargar el modulo nativo de impresion.',
      };
    }
  }

  private async loadPrinterModule(): Promise<PrinterModule> {
    if (process.platform !== 'win32') {
      throw new Error('Gestion al Dia Print Agent solo soporta impresion directa en Windows.');
    }

    const attemptedPaths: string[] = [];
    const candidateModulePaths = [
      'printer',
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'printer'),
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'printer',
        'lib',
        'printer',
      ),
      path.join(__dirname, '..', '..', 'node_modules', 'printer'),
      path.join(__dirname, '..', '..', 'node_modules', 'printer', 'lib', 'printer'),
    ];

    let lastError: unknown = null;

    for (const candidatePath of candidateModulePaths) {
      attemptedPaths.push(candidatePath);

      try {
        if (candidatePath !== 'printer' && !modulePathExists(candidatePath)) {
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loadedModule = require(candidatePath) as PrinterModule;

        if (
          loadedModule &&
          typeof loadedModule.getPrinters === 'function' &&
          typeof loadedModule.printDirect === 'function'
        ) {
          this.logger.info('Modulo nativo de impresion cargado correctamente.', {
            candidatePath,
          });
          return loadedModule;
        }
      } catch (error) {
        lastError = error;
      }
    }

    this.logger.error('No fue posible cargar el modulo nativo de impresion.', {
      attemptedPaths,
      lastError,
    });

    const errorDetails =
      lastError instanceof Error && lastError.message.trim()
        ? ` Detalle: ${lastError.message.trim()}`
        : '';

    throw new Error(
      `No fue posible cargar el modulo de impresion nativo.${errorDetails} Intentos: ${attemptedPaths.join(' | ')}`,
    );
  }
}

function normalizePrinterStatus(value: string | string[] | undefined): PrinterDescriptor['status'] {
  const normalizedValues = (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (!normalizedValues.length) {
    return 'unknown';
  }

  if (normalizedValues.includes('offline')) {
    return 'offline';
  }

  if (
    normalizedValues.includes('online') ||
    normalizedValues.includes('idle') ||
    normalizedValues.includes('waiting') ||
    normalizedValues.includes('printing') ||
    normalizedValues.includes('processing')
  ) {
    return 'ready';
  }

  return 'unknown';
}

function resolvePrinterDisplayName(printer: {
  name?: string;
  printerName?: string;
}): string {
  const candidateName =
    (typeof printer.name === 'string' && printer.name.trim()) ||
    (typeof printer.printerName === 'string' && printer.printerName.trim());

  return candidateName || 'Impresora sin nombre';
}

function modulePathExists(modulePath: string): boolean {
  if (fs.existsSync(modulePath)) {
    return true;
  }

  if (fs.existsSync(`${modulePath}.js`)) {
    return true;
  }

  if (fs.existsSync(`${modulePath}.node`)) {
    return true;
  }

  return false;
}
