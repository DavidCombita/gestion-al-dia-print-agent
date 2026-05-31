import { ReceiptJobPayload } from '../../shared/contracts';
import { buildEscPosDocument } from '../escpos-builder';

export function formatTestTicket(payload: ReceiptJobPayload): Buffer {
  return buildEscPosDocument(payload, {
    title: 'Ticket de prueba',
    showTotals: true,
  });
}
