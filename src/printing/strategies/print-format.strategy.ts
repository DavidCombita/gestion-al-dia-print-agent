import {
  BackendPrintJobType,
  BackendPrintPayload,
} from '../../shared/contracts';

export interface PrintFormatStrategy {
  readonly jobType: BackendPrintJobType;
  format(payload: BackendPrintPayload): Buffer;
}
