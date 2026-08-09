import { PrintTransportType } from './printer-profile';

export type RetrySafety = 'SAFE_TO_RETRY' | 'UNSAFE_TO_RETRY';

export type PrintLifecycleStatus =
  | 'QUEUED'
  | 'FORMATTING'
  | 'READY'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'SPOOLING'
  | 'PRINTING'
  | 'SPOOL_COMPLETED'
  | 'FAILED'
  | 'STUCK'
  | 'CANCELLED'
  | 'UNKNOWN';

export type PrintTerminalStatus = Extract<
  PrintLifecycleStatus,
  'SPOOL_COMPLETED' | 'FAILED' | 'STUCK' | 'CANCELLED' | 'UNKNOWN'
>;

export interface PrinterTarget {
  systemName: string;
  displayName?: string;
}

export interface PrintTransportRequest {
  printer: PrinterTarget;
  documentName: string;
  rawData?: Buffer;
  html?: string;
  payloadBytes: number;
  driverOptions?: {
    usePrinterDefaultPageSize: boolean;
  };
}

export interface SubmittedPrintJob {
  transport: PrintTransportType;
  printerName: string;
  documentName: string;
  systemJobId?: number;
  submittedAt: string;
  payloadBytes?: number;
}

export interface PrintTransportJobStatus {
  state: Exclude<PrintLifecycleStatus, 'QUEUED' | 'FORMATTING' | 'READY' | 'SUBMITTING'>;
  exists?: boolean;
  observed: boolean;
  windowsStatusNumber?: number;
  windowsStatusLabels?: string[];
  code?: string;
  message?: string;
  retrySafety: RetrySafety;
}

export interface PrinterTransportHealth {
  available: boolean;
  message?: string;
}

export interface PrintTransport {
  readonly type: PrintTransportType;

  submit(request: PrintTransportRequest): Promise<SubmittedPrintJob>;
  getJobStatus(job: SubmittedPrintJob): Promise<PrintTransportJobStatus>;
  cancel?(job: SubmittedPrintJob): Promise<void>;
  healthCheck?(printer: PrinterTarget): Promise<PrinterTransportHealth>;
  dispose?(): void | Promise<void>;
}

export class PrintTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retrySafety: RetrySafety,
    readonly acceptedByWindows: boolean,
  ) {
    super(message);
    this.name = 'PrintTransportError';
  }
}
