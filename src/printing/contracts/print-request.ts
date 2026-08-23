import {
  BackendPrintJobType,
  BackendPrintPayload,
  PaperWidth,
} from '../../shared/contracts';
import { PrintTransportType } from './printer-profile';

export type PrintRequestSource = 'BACKEND' | 'LOCAL' | 'DIAGNOSTIC';

export interface PreparedPrintDocument {
  rawData?: Buffer;
  html?: string;
}

export interface SpoolAcceptedNotification {
  localJobId: string;
  localAttemptId: string;
  copyNumber: number;
  windowsJobId: number;
  printerName: string;
  documentName: string;
  submittedAt: string;
  payloadBytes?: number;
}

export interface PrintExecutionRequest {
  source: PrintRequestSource;
  jobType: BackendPrintJobType;
  payload?: BackendPrintPayload;
  preparedDocument?: PreparedPrintDocument;
  backendJobId?: string;
  printerName: string;
  displayPrinterName?: string;
  documentName?: string;
  copies?: number;
  paperWidth?: PaperWidth;
  transportOverride?: PrintTransportType;
  onSpoolAccepted?: (notification: SpoolAcceptedNotification) => void;
}
