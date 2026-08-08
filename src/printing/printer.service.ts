import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrinterDescriptor } from '../shared/contracts';

const PRINT_DIRECT_TIMEOUT_MS = 15_000;

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

type NativePrinterModule = {
  getPrinters: PrinterModule['getPrinters'];
  getDefaultPrinterName?: () => string;
  printDirect: (
    data: Buffer,
    printerName: string,
    documentName: string,
    type: 'RAW',
    options: Record<string, unknown>,
  ) => unknown;
};

export interface PrinterSpoolJobSnapshot {
  id?: number;
  documentName: string;
  status?: string;
  submittedAt?: string;
  sizeBytes?: number;
  totalPages?: number;
}

export class PrinterService {
  private printerModule: PrinterModule | null = null;

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
      let isSettled = false;
      const timeoutId = setTimeout(() => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        reject(
          new Error(
            `La impresora no respondio a tiempo para el trabajo "${documentName}".`,
          ),
        );
      }, PRINT_DIRECT_TIMEOUT_MS);

      try {
        printerModule.printDirect({
          data: payload,
          type: 'RAW',
          printer: targetPrinterName,
          docname: documentName,
          success: () => {
            if (isSettled) {
              return;
            }

            isSettled = true;
            clearTimeout(timeoutId);
            this.logger.info('Trabajo enviado a la impresora.', {
              targetPrinterName,
              documentName,
            });
            resolve();
          },
          error: (error) => {
            if (isSettled) {
              return;
            }

            isSettled = true;
            clearTimeout(timeoutId);
            reject(createPrintError(error, targetPrinterName, documentName));
          },
        });
      } catch (error) {
        if (isSettled) {
          return;
        }

        isSettled = true;
        clearTimeout(timeoutId);
        reject(createPrintError(error, targetPrinterName, documentName));
      }
    });
  }

  async findSpoolJob(
    targetPrinterName: string,
    documentName: string,
  ): Promise<PrinterSpoolJobSnapshot | null> {
    if (process.platform !== 'win32') {
      return null;
    }

    try {
      const rawOutput = await execFileText('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildFindSpoolJobScript(targetPrinterName),
      ]);
      const spoolJobs = parseSpoolJobs(rawOutput);

      return (
        spoolJobs.find((job) => job.documentName === documentName) ?? null
      );
    } catch (error) {
      this.logger.warn('No fue posible consultar la cola de impresion de Windows.', {
        targetPrinterName,
        documentName,
        error:
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : String(error),
      });
      return null;
    }
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
      kind === 'invoice'
        ? config.invoicePrinterName
        : config.kitchenPrinterName ?? config.invoicePrinterName;

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

    if (this.printerModule) {
      return this.printerModule;
    }

    const attemptedPaths: string[] = [];
    const candidateModulePaths = [
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'printer',
        'build',
        'Release',
        'node_printer.node',
      ),
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'printer',
        'lib',
        'node_printer.node',
      ),
      path.join(
        __dirname,
        '..',
        '..',
        'node_modules',
        'printer',
        'build',
        'Release',
        'node_printer.node',
      ),
      path.join(
        __dirname,
        '..',
        '..',
        'node_modules',
        'printer',
        'lib',
        'node_printer.node',
      ),
      'printer',
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'printer'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'printer', 'lib', 'printer'),
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
        const loadedModule = require(candidatePath) as PrinterModule | NativePrinterModule;
        const isNativeBinaryCandidate = candidatePath.endsWith('.node');

        if (isNativeBinaryCandidate && isNativePrinterModule(loadedModule)) {
          this.printerModule = createPrinterModuleFromNative(loadedModule);
          this.logger.info('Modulo nativo de impresion cargado correctamente.', {
            candidatePath,
            mode: 'native-binary',
          });
          return this.printerModule;
        }

        if (!isNativeBinaryCandidate && isPrinterModule(loadedModule)) {
          this.printerModule = loadedModule;
          this.logger.info('Modulo nativo de impresion cargado correctamente.', {
            candidatePath,
            mode: 'package-wrapper',
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

function isNativePrinterModule(value: unknown): value is NativePrinterModule {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as NativePrinterModule).getPrinters === 'function' &&
      typeof (value as NativePrinterModule).printDirect === 'function',
  );
}

function isPrinterModule(value: unknown): value is PrinterModule {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as PrinterModule).getPrinters === 'function' &&
      typeof (value as PrinterModule).printDirect === 'function',
  );
}

function createPrinterModuleFromNative(nativePrinter: NativePrinterModule): PrinterModule {
  return {
    getPrinters: nativePrinter.getPrinters.bind(nativePrinter),
    getDefaultPrinterName:
      typeof nativePrinter.getDefaultPrinterName === 'function'
        ? nativePrinter.getDefaultPrinterName.bind(nativePrinter)
        : undefined,
    printDirect: (options: PrintDirectOptions) => {
      const printerName = options.printer.trim() || nativePrinter.getDefaultPrinterName?.() || '';
      const documentName = options.docname.trim() || 'Gestion al Dia Print Agent';

      try {
        nativePrinter.printDirect(
          options.data,
          printerName,
          documentName,
          options.type,
          {},
        );
        options.success();
      } catch (error) {
        options.error(error);
      }
    },
  };
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

function buildFindSpoolJobScript(targetPrinterName: string): string {
  const encodedPrinterName = Buffer.from(targetPrinterName, 'utf8').toString('base64');

  return [
    `$printerName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPrinterName}'))`,
    '$jobs = @(Get-PrintJob -PrinterName $printerName -ErrorAction Stop | Select-Object Id,DocumentName,JobStatus,SubmittedTime,Size,TotalPages)',
    '$jobs | ConvertTo-Json -Compress',
  ].join('; ');
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        if (stderr.trim()) {
          reject(new Error(stderr.trim()));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function parseSpoolJobs(rawOutput: string): PrinterSpoolJobSnapshot[] {
  const normalizedOutput = rawOutput.trim();

  if (!normalizedOutput) {
    return [];
  }

  const parsedValue = JSON.parse(normalizedOutput);
  const values = Array.isArray(parsedValue) ? parsedValue : [parsedValue];

  return values
    .map(normalizeSpoolJob)
    .filter((job): job is PrinterSpoolJobSnapshot => job !== null);
}

function normalizeSpoolJob(value: unknown): PrinterSpoolJobSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const documentName = readString(record.DocumentName);

  if (!documentName) {
    return null;
  }

  return {
    id: readNumber(record.Id),
    documentName,
    status: readString(record.JobStatus),
    submittedAt: readString(record.SubmittedTime),
    sizeBytes: readNumber(record.Size),
    totalPages: readNumber(record.TotalPages),
  };
}

function readString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .join(', ') || undefined;
  }

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function createPrintError(
  error: unknown,
  targetPrinterName: string,
  documentName: string,
): Error {
  if (typeof error === 'string' && error.trim()) {
    return new Error(error.trim());
  }

  if (error instanceof Error && error.message.trim()) {
    return new Error(error.message.trim());
  }

  return new Error(
    `La impresion RAW fallo para "${documentName}" en la impresora "${targetPrinterName}".`,
  );
}
