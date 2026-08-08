import { BackendPrintPayload } from '../../shared/contracts';
import { formatTestTicket } from '../formatters/test-ticket.formatter';
import { requireReceiptPayload } from './payload-guards';
import { PrintFormatStrategy } from './print-format.strategy';

export class TestTicketPrintStrategy implements PrintFormatStrategy {
  readonly jobType = 'TEST_PRINT';

  format(payload: BackendPrintPayload): Buffer {
    return formatTestTicket(requireReceiptPayload(payload, this.jobType));
  }
}
