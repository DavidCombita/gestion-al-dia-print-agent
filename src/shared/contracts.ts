import type { PrinterProfile } from '../printing/contracts/printer-profile';
import type {
  PrintJobRecord,
  PrintExecutionResult,
} from '../printing/contracts/print-result';

export type PaperWidth = '58mm' | '80mm';

export interface AgentHealthResponse {
  status: 'ok';
  app: 'Gestion Al Dia Print Agent';
  version: string;
  platform: NodeJS.Platform;
  pairingRequired: boolean;
  configured: boolean;
  printerModuleReady: boolean;
  printerModuleError?: string;
  backend: {
    linked: boolean;
    baseUrl: string | null;
    agentId: string | null;
    businessId: string | null;
    connected?: boolean;
    lastContactAt?: string;
    lastDisconnectReason?: string;
    lastError?: {
      at: string;
      message: string;
    };
  };
  uptimeSeconds?: number;
  queue?: {
    pendingJobs: number;
    isProcessing: boolean;
    activeJobLabel?: string;
    printers?: Array<{
      printerName: string;
      pendingJobs: number;
      isProcessing: boolean;
      health: 'HEALTHY' | 'BLOCKED';
      blockReason?: string;
    }>;
  };
}

export interface PrinterDescriptor {
  name: string;
  isDefault: boolean;
  status: 'ready' | 'offline' | 'error' | 'unknown';
}

export interface AgentPrinterConfig {
  invoicePrinterName: string | null;
  kitchenPrinterName: string | null;
  invoiceCopies: number;
  kitchenCopies: number;
  invoiceEnabled: boolean;
  kitchenEnabled: boolean;
  paperWidth: PaperWidth;
  pairingToken: string | null;
  allowedOrigins: string[];
  backendBaseUrl: string | null;
  backendAgentId: string | null;
  backendBusinessId: string | null;
  backendDeviceToken: string | null;
  printerProfiles: PrinterProfile[];
  printJobPollIntervalMs: number;
  printJobCompletionTimeoutMs: number;
  maxPendingPrintJobsPerPrinter: number;
}

export interface BusinessPrintPayload {
  name: string;
  nit: string;
  address?: string;
  phone?: string;
}

export interface OrderPrintPayload {
  id: string;
  tableName?: string;
  waiterName?: string;
  createdAt: string;
}

export interface PrintItemPayload {
  name: string;
  quantity: number;
  unitPrice?: number;
  total?: number;
  notes?: string | string[];
}

export interface TotalsPrintPayload {
  subtotal?: number;
  tax?: number;
  discount?: number;
  tip?: number;
  total?: number;
  paid?: number;
  change?: number;
}

export interface PaymentBreakdownPrintPayload {
  label: string;
  amount: number;
}

export interface PrintOptionsPayload {
  copies?: number;
  paperWidth?: PaperWidth;
  charactersPerLine?: number;
  cutPaper?: boolean;
  openCashDrawer?: boolean;
  showTotals?: boolean;
  showItemPrices?: boolean;
}

export interface ReceiptJobPayload {
  business: BusinessPrintPayload;
  order: OrderPrintPayload;
  title?: string;
  items: PrintItemPayload[];
  totals?: TotalsPrintPayload;
  paymentMethod?: string;
  paymentBreakdown?: PaymentBreakdownPrintPayload[];
  options?: PrintOptionsPayload;
}

export interface ThermalReportRow {
  label: string;
  value?: string;
  details?: string[];
}

export interface ThermalReportSection {
  title: string;
  rows: ThermalReportRow[];
}

export interface ThermalReportJobPayload {
  version: 1;
  reportKind: 'INVENTORY' | 'SHIFT';
  title: string;
  reference?: string;
  business: BusinessPrintPayload;
  generatedAt: string;
  generatedBy: string;
  metadata: ThermalReportRow[];
  sections: ThermalReportSection[];
  options?: PrintOptionsPayload;
}

export type BackendPrintPayload = ReceiptJobPayload | ThermalReportJobPayload;

export type BackendPrintJobType =
  | 'KITCHEN_TICKET'
  | 'RECEIPT'
  | 'INVENTORY_REPORT'
  | 'SHIFT_REPORT'
  | 'CASH_CLOSING'
  | 'TEST_PRINT';

export interface ConfigResponse {
  config: AgentPrinterConfig;
}

export interface PrintersResponse {
  printers: PrinterDescriptor[];
}

export interface AgentMutationResponse {
  success: boolean;
  message: string;
}

export interface PrintJobsResponse {
  jobs: PrintJobRecord[];
}

export type { PrintExecutionResult, PrintJobRecord };
