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
  uptimeSeconds?: number;
  queue?: {
    pendingJobs: number;
    isProcessing: boolean;
    activeJobLabel?: string;
  };
}

export interface PrinterDescriptor {
  name: string;
  isDefault: boolean;
  status: 'ready' | 'offline' | 'unknown';
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
  total?: number;
  paid?: number;
  change?: number;
}

export interface PrintOptionsPayload {
  copies?: number;
  paperWidth?: PaperWidth;
  cutPaper?: boolean;
  openCashDrawer?: boolean;
}

export interface ReceiptJobPayload {
  business: BusinessPrintPayload;
  order: OrderPrintPayload;
  items: PrintItemPayload[];
  totals?: TotalsPrintPayload;
  options?: PrintOptionsPayload;
}

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
