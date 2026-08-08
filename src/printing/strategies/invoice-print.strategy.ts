import {
  BackendPrintJobType,
  BackendPrintPayload,
} from '../../shared/contracts';
import { formatInvoice } from '../formatters/invoice.formatter';
import { requireReceiptPayload } from './payload-guards';
import { PrintFormatStrategy } from './print-format.strategy';

export class InvoicePrintStrategy implements PrintFormatStrategy {
  constructor(readonly jobType: BackendPrintJobType = 'RECEIPT') {}

  format(payload: BackendPrintPayload): Buffer {
    return formatInvoice(requireReceiptPayload(payload, this.jobType));
  }
}
