import { ReceiptJobPayload } from '../../shared/contracts';
import { buildEscPosDocument } from '../escpos-builder';

export function formatInvoice(payload: ReceiptJobPayload): Buffer {
  return buildEscPosDocument(payload, {
    title: payload.title?.trim() || 'Factura',
    showTotals: true,
    showItemPrices: true,
    showBusinessContactAtFooter: true,
  });
}
