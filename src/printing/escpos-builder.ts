import { ReceiptJobPayload } from '../shared/contracts';

const ESC = '\x1b';
const GS = '\x1d';

export interface EscPosDocumentOptions {
  title: string;
  showTotals: boolean;
}

export function buildEscPosDocument(
  payload: ReceiptJobPayload,
  options: EscPosDocumentOptions,
): Buffer {
  const paperWidth = payload.options?.paperWidth ?? '80mm';
  const columns = paperWidth === '58mm' ? 32 : 48;
  const lines: string[] = [];

  lines.push(center(options.title.toUpperCase(), columns));
  lines.push(center(payload.business.name, columns));

  if (payload.business.nit) {
    lines.push(center(`NIT ${payload.business.nit}`, columns));
  }

  if (payload.business.address) {
    lines.push(center(payload.business.address, columns));
  }

  if (payload.business.phone) {
    lines.push(center(payload.business.phone, columns));
  }

  lines.push('-'.repeat(columns));
  lines.push(`Pedido: ${payload.order.id}`);
  lines.push(`Fecha: ${payload.order.createdAt}`);

  if (payload.order.tableName) {
    lines.push(`Mesa: ${payload.order.tableName}`);
  }

  if (payload.order.waiterName) {
    lines.push(`Atiende: ${payload.order.waiterName}`);
  }

  lines.push('-'.repeat(columns));

  for (const item of payload.items) {
    lines.push(trimLine(`${item.quantity} x ${item.name}`, columns));

    if (typeof item.total === 'number') {
      lines.push(alignCurrency(item.total, columns));
    }

    const notes = Array.isArray(item.notes)
      ? item.notes
      : item.notes
        ? [item.notes]
        : [];

    for (const note of notes) {
      lines.push(trimLine(`  * ${note}`, columns));
    }
  }

  if (options.showTotals && payload.totals) {
    lines.push('-'.repeat(columns));
    pushTotal(lines, 'Subtotal', payload.totals.subtotal, columns);
    pushTotal(lines, 'Impuesto', payload.totals.tax, columns);
    pushTotal(lines, 'Descuento', payload.totals.discount, columns);
    pushTotal(lines, 'TOTAL', payload.totals.total, columns);
    pushTotal(lines, 'Pagado', payload.totals.paid, columns);
    pushTotal(lines, 'Cambio', payload.totals.change, columns);
  }

  lines.push('-'.repeat(columns));
  lines.push(center('Gestion al Dia', columns));

  const commands = [
    `${ESC}@`,
    `${ESC}a\x01`,
    `${lines.join('\n')}\n`,
    payload.options?.openCashDrawer ? `${ESC}p\x00\x19\xfa` : '',
    payload.options?.cutPaper === false ? '' : `${GS}V\x00`,
  ].join('');

  return Buffer.from(commands, 'binary');
}

function pushTotal(lines: string[], label: string, value: number | undefined, columns: number): void {
  if (typeof value !== 'number') {
    return;
  }

  const formatted = formatCurrency(value);
  const spacing = Math.max(1, columns - label.length - formatted.length);
  lines.push(`${label}${' '.repeat(spacing)}${formatted}`);
}

function alignCurrency(value: number, columns: number): string {
  return `${' '.repeat(Math.max(0, columns - formatCurrency(value).length))}${formatCurrency(value)}`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(value);
}

function center(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }

  const leftPadding = Math.floor((width - value.length) / 2);
  return `${' '.repeat(leftPadding)}${value}`;
}

function trimLine(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}
