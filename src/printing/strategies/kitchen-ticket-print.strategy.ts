import { BackendPrintPayload } from '../../shared/contracts';
import { formatKitchenOrder } from '../formatters/kitchen-order.formatter';
import { requireReceiptPayload } from './payload-guards';
import { PrintFormatStrategy } from './print-format.strategy';

export class KitchenTicketPrintStrategy implements PrintFormatStrategy {
  readonly jobType = 'KITCHEN_TICKET';

  format(payload: BackendPrintPayload): Buffer {
    return formatKitchenOrder(requireReceiptPayload(payload, this.jobType));
  }
}
