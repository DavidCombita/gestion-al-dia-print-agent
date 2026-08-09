import crypto from 'node:crypto';
import { PrintExecutionResult } from '../contracts/print-result';
import { PrinterProfileService } from '../printers/printer-profile.service';
import { PrinterDiscoveryService } from '../printers/printer-discovery.service';
import { PrinterQueueService } from '../queue/printer-queue.service';
import { PrintHistoryService } from '../history/print-history.service';
import { PrintOrchestratorService } from '../print-orchestrator.service';
import { WindowsPrintDiagnosticsService } from './windows-print-diagnostics.service';
import { ReceiptJobPayload } from '../../shared/contracts';
import { escapeHtml } from '../formatters/html-ticket.formatter';

const ESC = 0x1b;

export interface PrintAgentRuntimeInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  arch: string;
}

export class PrintDiagnosticsService {
  constructor(
    private readonly orchestrator: PrintOrchestratorService,
    private readonly profileService: PrinterProfileService,
    private readonly discoveryService: PrinterDiscoveryService,
    private readonly queueService: PrinterQueueService,
    private readonly historyService: PrintHistoryService,
    private readonly windowsDiagnostics: WindowsPrintDiagnosticsService,
    private readonly agentRuntime: PrintAgentRuntimeInfo,
  ) {}

  async runRawMinimal(printerName: string): Promise<PrintExecutionResult> {
    await this.orchestrator.preparePrinterForManualTest(printerName);
    const rawData = Buffer.concat([
      Buffer.from([ESC, 0x40]),
      Buffer.from('GESTION AL DIA\nPRUEBA RAW\n1234567890\n\n\n', 'ascii'),
    ]);

    return this.orchestrator.execute({
      source: 'DIAGNOSTIC',
      jobType: 'TEST_PRINT',
      preparedDocument: { rawData },
      printerName,
      documentName: 'PRUEBA-RAW-MINIMA',
      copies: 1,
      transportOverride: 'WINDOWS_RAW',
    });
  }

  async runRawFull(printerName: string): Promise<PrintExecutionResult> {
    await this.orchestrator.preparePrinterForManualTest(printerName);
    const profile = this.profileService.resolveProfile(printerName);
    return this.orchestrator.execute({
      source: 'DIAGNOSTIC',
      jobType: 'TEST_PRINT',
      payload: buildDiagnosticPayload(profile.paperWidth),
      printerName,
      documentName: 'PRUEBA-RAW-COMPLETA',
      copies: 1,
      transportOverride: 'WINDOWS_RAW',
    });
  }

  async runDriver(printerName: string): Promise<PrintExecutionResult> {
    await this.orchestrator.preparePrinterForManualTest(printerName);
    const profile = this.profileService.resolveProfile(printerName);
    const html = buildDriverDiagnosticHtml(printerName, profile.paperWidth);
    return this.orchestrator.execute({
      source: 'DIAGNOSTIC',
      jobType: 'TEST_PRINT',
      preparedDocument: { html },
      printerName,
      documentName: 'PRUEBA-WINDOWS-DRIVER',
      copies: 1,
      transportOverride: 'WINDOWS_DRIVER',
    });
  }

  async runInvoice(printerName: string): Promise<PrintExecutionResult> {
    await this.orchestrator.preparePrinterForManualTest(printerName);
    const profile = this.profileService.resolveProfile(printerName);
    return this.orchestrator.execute({
      source: 'DIAGNOSTIC',
      jobType: 'RECEIPT',
      payload: buildTestInvoicePayload(profile.paperWidth, printerName),
      printerName,
      documentName: 'FACTURA-PRUEBA',
      copies: 1,
      paperWidth: profile.paperWidth,
    });
  }

  async getOverview(): Promise<{
    printers: Array<{
      name: string;
      systemName: string;
      transport: string;
      paperWidth: string;
      agentStatus: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
      queue: ReturnType<PrinterQueueService['getPrinterSnapshot']>;
      lastJob: ReturnType<PrintHistoryService['getLatestForPrinter']>;
    }>;
  }> {
    const printers = await this.discoveryService.listPrinters();

    return {
      printers: printers.map((printer) => {
        const profile = this.profileService.resolveProfile(printer.name);
        const queue = this.queueService.getPrinterSnapshot(printer.name);
        return {
          name: printer.name,
          systemName: profile.systemName,
          transport: profile.transport,
          paperWidth: profile.paperWidth,
          agentStatus:
            queue.health === 'BLOCKED'
              ? 'BLOCKED'
              : printer.status === 'ready'
                ? 'HEALTHY'
                : 'DEGRADED',
          queue,
          lastJob: this.historyService.getLatestForPrinter(printer.name),
        };
      }),
    };
  }

  async exportDiagnostic(printerName: string): Promise<Record<string, unknown>> {
    const moduleStatus = await this.discoveryService.getModuleStatus();
    const windows = await this.windowsDiagnostics.inspectPrinter(printerName);
    const profile = this.profileService.resolveProfile(printerName);
    const lastJob = this.historyService.getLatestForPrinter(printerName);

    return {
      printer: windows.printer ?? { name: printerName },
      port: windows.port,
      windowsDiagnosticError: windows.error,
      agent: {
        ...this.agentRuntime,
        printerModulePath: moduleStatus.runtime?.printerModulePath,
        printerBinaryPath: moduleStatus.runtime?.printerBinaryPath,
        printerModuleMode: moduleStatus.runtime?.printerModuleMode,
        printerPackageVersion: moduleStatus.runtime?.printerPackageVersion,
      },
      transport: {
        configuredTransport: profile.transport,
        profile,
      },
      queue: this.queueService.getPrinterSnapshot(printerName),
      lastJob: lastJob
        ? {
            backendJobId: lastJob.backendJobId,
            localJobId: lastJob.localJobId,
            windowsJobId: lastJob.windowsJobId,
            status: lastJob.status,
            lastWindowsStatus: lastJob.lastWindowsStatus,
            elapsedMs: lastJob.elapsedMs,
          }
        : null,
    };
  }
}

function buildDiagnosticPayload(paperWidth: '58mm' | '80mm'): ReceiptJobPayload {
  return {
    business: {
      name: 'Gestion al Dia',
      nit: '900123456-7',
      address: 'Diagnostico de impresion',
    },
    order: {
      id: 'DIAG-RAW',
      createdAt: new Date().toISOString(),
      waiterName: 'Print Agent',
    },
    items: [
      {
        name: 'Prueba ESC/POS completa',
        quantity: 1,
        total: 0,
        notes: 'Incluye formato, alimentacion y corte configurado',
      },
    ],
    totals: { total: 0 },
    options: {
      copies: 1,
      paperWidth,
      cutPaper: true,
      openCashDrawer: false,
    },
  };
}

function buildTestInvoicePayload(
  paperWidth: '58mm' | '80mm',
  printerName: string,
): ReceiptJobPayload {
  const reference = crypto.randomUUID().slice(0, 8).toUpperCase();

  return {
    title: 'FACTURA DE PRUEBA',
    business: {
      name: 'Gestion al Dia Restaurante',
      nit: '900123456-7',
      address: 'Calle 123 # 45-67',
      phone: '+57 300 123 4567',
    },
    order: {
      id: `PRUEBA-${reference}`,
      createdAt: new Date().toISOString(),
      tableName: 'Mesa 10',
      waiterName: 'Agente de impresion',
    },
    items: [
      {
        name: 'Cafe colombiano',
        quantity: 2,
        unitPrice: 5_000,
        total: 10_000,
      },
      {
        name: 'Almuerzo ejecutivo',
        quantity: 1,
        unitPrice: 32_000,
        total: 32_000,
        notes: 'Sin cebolla y con ensalada',
      },
      {
        name: 'Postre de la casa',
        quantity: 1,
        unitPrice: 8_000,
        total: 8_000,
        notes: `Impresora: ${printerName}`,
      },
    ],
    totals: {
      subtotal: 50_000,
      tax: 0,
      discount: 5_000,
      tip: 3_000,
      total: 48_000,
      paid: 50_000,
      change: 2_000,
    },
    paymentMethod: 'Efectivo',
    paymentBreakdown: [{ label: 'Efectivo', amount: 50_000 }],
    options: {
      copies: 1,
      paperWidth,
      cutPaper: true,
      openCashDrawer: false,
      showTotals: true,
      showItemPrices: true,
    },
  };
}

function buildDriverDiagnosticHtml(
  printerName: string,
  paperWidth: '58mm' | '80mm',
): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>PRUEBA-WINDOWS-DRIVER</title><style>@page{margin:0}body{width:${paperWidth};margin:0;padding:2mm;font:13px/1.4 "Courier New",monospace;text-align:center;color:#000;background:#fff}h1{font-size:16px;margin:0 0 3mm}p{margin:1mm 0}</style></head><body><h1>GESTION AL DIA</h1><p>PRUEBA WINDOWS DRIVER</p><p>${escapeHtml(printerName)}</p><p>1234567890</p></body></html>`;
}
