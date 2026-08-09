import {
  BackendPrintJobType,
  BackendPrintPayload,
  ReceiptJobPayload,
  ThermalReportJobPayload,
} from '../../shared/contracts';
import {
  requireReceiptPayload,
  requireThermalReportPayload,
} from '../strategies/payload-guards';

export function formatPrintJobHtml(
  jobType: BackendPrintJobType,
  payload: BackendPrintPayload,
  documentName: string,
): string {
  const body =
    jobType === 'INVENTORY_REPORT'
      ? renderReport(requireThermalReportPayload(payload, jobType, 'INVENTORY'))
      : jobType === 'SHIFT_REPORT'
        ? renderReport(requireThermalReportPayload(payload, jobType, 'SHIFT'))
        : renderReceipt(requireReceiptPayload(payload, jobType), jobType);
  const width = payload.options?.paperWidth === '58mm' ? '58mm' : '80mm';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(documentName)}</title>
    <style>
      @page { margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; width: ${width}; padding: 2mm; color: #000; background: #fff; font: 12px/1.3 "Courier New", monospace; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 16px; text-align: center; }
      h2 { margin-top: 3mm; font-size: 13px; }
      .center { text-align: center; }
      .rule { border-top: 1px dashed #000; margin: 2mm 0; }
      .row { display: flex; justify-content: space-between; gap: 2mm; }
      .item { margin: 1.5mm 0; }
      .notes { padding-left: 3mm; }
      .total { font-weight: 700; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderReceipt(
  payload: ReceiptJobPayload,
  jobType: BackendPrintJobType,
): string {
  const showPrices =
    jobType !== 'KITCHEN_TICKET' && payload.options?.showItemPrices !== false;
  const title =
    payload.title?.trim() ||
    (jobType === 'KITCHEN_TICKET' ? 'Comanda cocina' : 'Factura');
  const items = payload.items
    .map((item) => {
      const notes = (Array.isArray(item.notes) ? item.notes : item.notes ? [item.notes] : [])
        .map((note) => `<div class="notes">* ${escapeHtml(note)}</div>`)
        .join('');
      const amount =
        showPrices && typeof item.total === 'number'
          ? `<span>${escapeHtml(formatCurrency(item.total))}</span>`
          : '';
      return `<div class="item"><div class="row"><span>${escapeHtml(item.quantity)} x ${escapeHtml(item.name)}</span>${amount}</div>${notes}</div>`;
    })
    .join('');
  const totals =
    jobType === 'KITCHEN_TICKET' || !payload.totals
      ? ''
      : `<div class="rule"></div>${renderAmount('Subtotal', payload.totals.subtotal)}${renderAmount('Impuestos', payload.totals.tax)}${renderAmount('Descuento', payload.totals.discount)}${renderAmount('Propina', payload.totals.tip)}${renderAmount('TOTAL', payload.totals.total, true)}${renderAmount('Pagado', payload.totals.paid)}${renderAmount('Cambio', payload.totals.change)}`;

  return `<h1>${escapeHtml(title)}</h1>
    <p class="center">${escapeHtml(payload.business.name)}</p>
    <p class="center">NIT ${escapeHtml(payload.business.nit)}</p>
    <div class="rule"></div>
    <p>Pedido: ${escapeHtml(payload.order.id)}</p>
    <p>Fecha: ${escapeHtml(payload.order.createdAt)}</p>
    ${payload.order.tableName ? `<p>Mesa: ${escapeHtml(payload.order.tableName)}</p>` : ''}
    ${payload.order.waiterName ? `<p>Atiende: ${escapeHtml(payload.order.waiterName)}</p>` : ''}
    <div class="rule"></div>${items}${totals}
    <div class="rule"></div><p class="center">Gestion al Dia</p>`;
}

function renderReport(payload: ThermalReportJobPayload): string {
  const metadata = payload.metadata.map(renderReportRow).join('');
  const sections = payload.sections
    .map(
      (section) =>
        `<h2>${escapeHtml(section.title)}</h2>${section.rows
          .map(renderReportRow)
          .join('')}`,
    )
    .join('');

  return `<h1>${escapeHtml(payload.title)}</h1>
    <p class="center">${escapeHtml(payload.business.name)}</p>
    <p class="center">NIT ${escapeHtml(payload.business.nit)}</p>
    <div class="rule"></div>
    <p>Generado: ${escapeHtml(payload.generatedAt)}</p>
    <p>Responsable: ${escapeHtml(payload.generatedBy)}</p>
    ${payload.reference ? `<p>Referencia: ${escapeHtml(payload.reference)}</p>` : ''}
    ${metadata}${sections}<div class="rule"></div><p class="center">Gestion al Dia</p>`;
}

function renderReportRow(row: ThermalReportJobPayload['metadata'][number]): string {
  const details = (row.details ?? [])
    .map((detail) => `<div class="notes">${escapeHtml(detail)}</div>`)
    .join('');
  return `<div class="row"><span>${escapeHtml(row.label)}</span><span>${escapeHtml(row.value ?? '')}</span></div>${details}`;
}

function renderAmount(label: string, value: number | undefined, total = false): string {
  if (typeof value !== 'number') {
    return '';
  }

  return `<div class="row${total ? ' total' : ''}"><span>${escapeHtml(label)}</span><span>${escapeHtml(formatCurrency(value))}</span></div>`;
}

function formatCurrency(value: number): string {
  return `$ ${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(value)}`;
}

