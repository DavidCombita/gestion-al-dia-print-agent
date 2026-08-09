import { execFile } from 'node:child_process';

export interface WindowsPrinterDiagnostic {
  available: boolean;
  printer?: {
    name?: string;
    driverName?: string;
    portName?: string;
    printProcessor?: string;
    datatype?: string;
    status?: string;
    keepPrintedJobs?: boolean;
  };
  port?: Record<string, unknown>;
  error?: string;
}

export class WindowsPrintDiagnosticsService {
  async inspectPrinter(printerName: string): Promise<WindowsPrinterDiagnostic> {
    if (process.platform !== 'win32') {
      return {
        available: false,
        error: 'El diagnostico PrintManagement solo esta disponible en Windows.',
      };
    }

    try {
      const output = await execFileText('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildDiagnosticScript(printerName),
      ]);
      const parsed = JSON.parse(output) as {
        printer?: Record<string, unknown>;
        port?: Record<string, unknown>;
      };
      const printer = parsed.printer ?? {};

      return {
        available: true,
        printer: {
          name: readString(printer.Name),
          driverName: readString(printer.DriverName),
          portName: readString(printer.PortName),
          printProcessor: readString(printer.PrintProcessor),
          datatype: readString(printer.Datatype),
          status: readString(printer.PrinterStatus),
          keepPrintedJobs:
            typeof printer.KeepPrintedJobs === 'boolean'
              ? printer.KeepPrintedJobs
              : undefined,
        },
        port: parsed.port,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function buildDiagnosticScript(printerName: string): string {
  const encodedName = Buffer.from(printerName, 'utf8').toString('base64');

  return [
    `$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))`,
    '$printer = Get-Printer -Name $name -Full -ErrorAction Stop',
    '$port = Get-PrinterPort -Name $printer.PortName -ErrorAction SilentlyContinue',
    '$result = [ordered]@{',
    'printer = $printer | Select-Object Name,DriverName,PortName,PrintProcessor,Datatype,PrinterStatus,KeepPrintedJobs',
    'port = $port | Select-Object Name,Description,PrinterHostAddress,PortNumber,SNMPEnabled',
    '}',
    '$result | ConvertTo-Json -Depth 5 -Compress',
  ].join('; ');
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
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

        resolve(stdout.trim());
      },
    );
  });
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

