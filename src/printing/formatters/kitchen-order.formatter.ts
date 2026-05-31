import { ReceiptJobPayload } from '../../shared/contracts';
import { buildEscPosDocument } from '../escpos-builder';

export function formatKitchenOrder(payload: ReceiptJobPayload): Buffer {
  return buildEscPosDocument(payload, {
    title: 'Comanda cocina',
    showTotals: false,
  });
}
