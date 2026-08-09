import {
  PrintLifecycleStatus,
  PrintTerminalStatus,
  RetrySafety,
} from './print-transport';
import { PrintTransportType } from './printer-profile';

export interface PrintJobRecord {
  localJobId: string;
  attemptId: string;
  backendJobId?: string;
  printerName: string;
  documentName: string;
  jobType: string;
  copyNumber: number;
  copies: number;
  transport: PrintTransportType;
  windowsJobId?: number;
  status: PrintLifecycleStatus;
  createdAt: string;
  submittedAt?: string;
  completedAt?: string;
  updatedAt: string;
  payloadBytes?: number;
  payloadHash?: string;
  errorCode?: string;
  errorMessage?: string;
  lastWindowsStatus?: string[];
  lastWindowsStatusNumber?: number;
  windowsJobObserved?: boolean;
  elapsedMs?: number;
  retrySafety: RetrySafety;
}

export interface PrintCopyResult {
  localJobId: string;
  attemptId: string;
  copyNumber: number;
  status: PrintTerminalStatus;
  retrySafety: RetrySafety;
  submitted: boolean;
  printerName: string;
  documentName: string;
  transport: PrintTransportType;
  systemJobId?: number;
  submittedAt?: string;
  completedAt: string;
  payloadBytes?: number;
  errorCode?: string;
  errorMessage?: string;
  lastWindowsStatus?: string[];
  lastWindowsStatusNumber?: number;
  elapsedMs: number;
}

export type PrintExecutionResultStatus =
  | PrintTerminalStatus
  | 'PARTIAL_FAILURE';

export interface PrintExecutionResult {
  status: PrintExecutionResultStatus;
  retrySafety: RetrySafety;
  printerName: string;
  transport: PrintTransportType;
  copies: number;
  attempts: PrintCopyResult[];
}

