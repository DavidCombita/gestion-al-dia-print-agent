import {
  ReceiptJobPayload,
  ThermalReportJobPayload,
  ThermalReportRow,
} from '../shared/contracts';

const ESC = 0x1b;
const GS = 0x1d;
const CODE_PAGE_CP850 = 0x02;

export interface EscPosDocumentOptions {
  title: string;
  showTotals: boolean;
  showItemPrices?: boolean;
  showBusinessContactAtFooter?: boolean;
}

type Alignment = 'left' | 'center' | 'right';

export function buildEscPosDocument(
  payload: ReceiptJobPayload,
  options: EscPosDocumentOptions,
): Buffer {
  const paperWidth = payload.options?.paperWidth ?? '80mm';
  const columns = paperWidth === '58mm' ? 32 : 48;
  const shouldShowItemPrices =
    options.showItemPrices ?? payload.options?.showItemPrices ?? true;
  const chunks: Buffer[] = [
    command(ESC, 0x40),
    command(ESC, 0x74, CODE_PAGE_CP850),
  ];

  const titleLines = [
    options.title.trim().toUpperCase(),
    payload.business.name.trim(),
    payload.business.nit ? `NIT ${payload.business.nit.trim()}` : '',
  ].filter(Boolean);
  const footerContactLines = options.showBusinessContactAtFooter
    ? [
        payload.business.address?.trim() ?? '',
        payload.business.phone?.trim() ?? '',
      ].filter(Boolean)
    : [];

  chunks.push(align('center'));
  chunks.push(command(ESC, 0x45, 0x01));
  chunks.push(command(GS, 0x21, 0x11));
  chunks.push(line(titleLines[0]));
  chunks.push(command(GS, 0x21, 0x00));
  chunks.push(command(ESC, 0x45, 0x00));

  for (const lineValue of titleLines.slice(1)) {
    chunks.push(line(lineValue));
  }

  chunks.push(blankLine());
  chunks.push(align('left'));
  chunks.push(line(divider(columns)));
  chunks.push(centeredSectionLine(`Pedido: ${payload.order.id}`, columns));
  chunks.push(centeredSectionLine(`Fecha: ${formatDate(payload.order.createdAt)}`, columns));

  if (payload.order.tableName?.trim()) {
    chunks.push(centeredSectionLine(`Mesa: ${payload.order.tableName.trim()}`, columns));
  }

  if (payload.order.waiterName?.trim()) {
    chunks.push(centeredSectionLine(`Atiende: ${payload.order.waiterName.trim()}`, columns));
  }

  chunks.push(line(divider(columns)));
  chunks.push(blankLine());

  for (const item of payload.items) {
    chunks.push(...buildItemLines(item, columns, shouldShowItemPrices));
  }

  chunks.push(line(divider(columns)));

  if (options.showTotals && payload.totals) {
    chunks.push(summaryLine('Subtotal', payload.totals.subtotal, columns));
    chunks.push(summaryLine('Impuestos', payload.totals.tax, columns));
    chunks.push(summaryLine('Descuento', payload.totals.discount, columns));
    chunks.push(summaryLine('Propina', payload.totals.tip, columns));
    chunks.push(command(ESC, 0x45, 0x01));
    chunks.push(summaryLine('TOTAL', payload.totals.total, columns));
    chunks.push(command(ESC, 0x45, 0x00));
    chunks.push(summaryLine('Pagado', payload.totals.paid, columns));
    chunks.push(summaryLine('Cambio', payload.totals.change, columns));
    chunks.push(line(divider(columns)));
  }

  if (payload.paymentBreakdown?.length) {
    chunks.push(line('METODOS DE PAGO'));
    for (const payment of payload.paymentBreakdown) {
      chunks.push(summaryLine(payment.label, payment.amount, columns));
    }
    chunks.push(line(divider(columns)));
  }

  chunks.push(blankLine());
  chunks.push(align('center'));
  chunks.push(line('Gracias por tu compra'));
  chunks.push(line('Gestion al Dia'));
  for (const contactLine of footerContactLines) {
    chunks.push(line(contactLine));
  }
  chunks.push(feed(5));

  if (payload.options?.openCashDrawer) {
    chunks.push(command(ESC, 0x70, 0x00, 0x19, 0xfa));
  }

  if (payload.options?.cutPaper !== false) {
    chunks.push(command(GS, 0x56, 0x41, 0x03));
  }

  return Buffer.concat(chunks);
}

export function buildEscPosReport(payload: ThermalReportJobPayload): Buffer {
  const paperWidth = payload.options?.paperWidth ?? '80mm';
  const columns = paperWidth === '58mm' ? 32 : 48;
  const chunks: Buffer[] = [
    command(ESC, 0x40),
    command(ESC, 0x74, CODE_PAGE_CP850),
    align('center'),
    command(ESC, 0x45, 0x01),
    command(GS, 0x21, 0x11),
    ...wrapText(payload.title.toUpperCase(), columns).map(line),
    command(GS, 0x21, 0x00),
    ...wrapText(payload.business.name, columns).map(line),
    command(ESC, 0x45, 0x00),
  ];

  if (payload.business.nit?.trim()) {
    chunks.push(line(`NIT ${payload.business.nit.trim()}`));
  }

  chunks.push(blankLine());
  chunks.push(align('left'));
  chunks.push(line(divider(columns)));
  chunks.push(
    ...buildReportField('Generado', formatDate(payload.generatedAt), columns),
  );
  chunks.push(...buildReportField('Responsable', payload.generatedBy, columns));

  if (payload.reference?.trim()) {
    chunks.push(...buildReportField('Referencia', payload.reference, columns));
  }

  for (const row of payload.metadata) {
    chunks.push(...buildThermalReportRow(row, columns, false));
  }

  chunks.push(line(divider(columns)));

  for (const section of payload.sections) {
    chunks.push(blankLine());
    chunks.push(command(ESC, 0x45, 0x01));
    chunks.push(...wrapText(section.title.toUpperCase(), columns).map(line));
    chunks.push(command(ESC, 0x45, 0x00));
    chunks.push(
      line('-'.repeat(Math.min(columns, Math.max(12, section.title.length)))),
    );

    for (const row of section.rows) {
      chunks.push(...buildThermalReportRow(row, columns, true));
    }
  }

  chunks.push(blankLine());
  chunks.push(line(divider(columns)));
  chunks.push(align('center'));
  chunks.push(line('Gestion al Dia'));

  if (payload.business.address?.trim()) {
    chunks.push(...wrapText(payload.business.address, columns).map(line));
  }

  if (payload.business.phone?.trim()) {
    chunks.push(...wrapText(payload.business.phone, columns).map(line));
  }

  chunks.push(feed(5));

  if (payload.options?.openCashDrawer) {
    chunks.push(command(ESC, 0x70, 0x00, 0x19, 0xfa));
  }

  if (payload.options?.cutPaper !== false) {
    chunks.push(command(GS, 0x56, 0x41, 0x03));
  }

  return Buffer.concat(chunks);
}

function buildThermalReportRow(
  row: ThermalReportRow,
  columns: number,
  addSpacing: boolean,
): Buffer[] {
  const chunks: Buffer[] = [];
  const label = normalizePrintableText(row.label).trim();
  const value = normalizePrintableText(row.value ?? '').trim();

  if (value && label.length + value.length + 1 <= columns) {
    chunks.push(
      line(
        padColumns(
          label,
          value,
          Math.max(1, columns - value.length - 1),
          value.length + 1,
        ),
      ),
    );
  } else {
    chunks.push(...wrapText(label, columns).map(line));

    if (value) {
      chunks.push(
        ...wrapText(value, Math.max(8, columns - 2)).map((text) =>
          line(`  ${text}`),
        ),
      );
    }
  }

  for (const detail of row.details ?? []) {
    chunks.push(
      ...wrapText(`  ${detail}`, Math.max(8, columns - 2)).map((text) =>
        line(`  ${text.trimStart()}`),
      ),
    );
  }

  if (addSpacing) {
    chunks.push(blankLine());
  }

  return chunks;
}

function buildReportField(
  label: string,
  value: string,
  columns: number,
): Buffer[] {
  return buildThermalReportRow({ label: `${label}:`, value }, columns, false);
}

function buildItemLines(
  item: ReceiptJobPayload['items'][number],
  columns: number,
  shouldShowItemPrices: boolean,
): Buffer[] {
  const chunks: Buffer[] = [];
  const quantityLabel = formatQuantity(item.quantity);
  const amountText =
    shouldShowItemPrices && typeof item.total === 'number'
      ? formatCurrency(item.total)
      : '';
  const prefix = `${quantityLabel} x `;
  const detailWidth = shouldShowItemPrices
    ? Math.max(12, columns - Math.max(10, amountText.length + 2))
    : columns;
  const itemLines = wrapText(`${prefix}${normalizePrintableText(item.name)}`, detailWidth);

  itemLines.forEach((currentLine, index) => {
    const rightSide = index === 0 ? amountText : '';
    chunks.push(line(padColumns(currentLine, rightSide, detailWidth, columns - detailWidth)));
  });

  const notes = Array.isArray(item.notes)
    ? item.notes
    : item.notes
      ? [item.notes]
      : [];

  for (const note of notes) {
    const noteLines = wrapText(`  * ${normalizePrintableText(note)}`, columns);
    for (const noteLine of noteLines) {
      chunks.push(line(noteLine));
    }
  }

  chunks.push(blankLine());
  return chunks;
}

function summaryLine(
  label: string,
  value: number | undefined,
  columns: number,
): Buffer {
  if (typeof value !== 'number') {
    return Buffer.alloc(0);
  }

  return line(padColumns(label, formatCurrency(value), columns - 14, 14));
}

function padColumns(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number,
): string {
  const leftText = fitText(left, leftWidth);
  const rightText = right ? right.padStart(rightWidth, ' ') : ''.padStart(rightWidth, ' ');
  return `${leftText.padEnd(leftWidth, ' ')}${rightText}`;
}

function fitText(value: string, width: number): string {
  const normalizedValue = normalizePrintableText(value);

  if (normalizedValue.length <= width) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, Math.max(0, width - 1))}.`;
}

function wrapText(value: string, width: number): string[] {
  const normalizedValue = normalizePrintableText(value).trim();

  if (!normalizedValue) {
    return [''];
  }

  const words = normalizedValue.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const candidateLine = currentLine ? `${currentLine} ${word}` : word;

    if (candidateLine.length <= width) {
      currentLine = candidateLine;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    if (word.length <= width) {
      currentLine = word;
      continue;
    }

    let remainingWord = word;

    while (remainingWord.length > width) {
      lines.push(remainingWord.slice(0, width));
      remainingWord = remainingWord.slice(width);
    }

    currentLine = remainingWord;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function divider(columns: number): string {
  return '-'.repeat(columns);
}

function formatQuantity(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCurrency(value: number | undefined): string {
  if (typeof value !== 'number') {
    return '$0';
  }

  const formattedValue = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);

  return `$ ${formattedValue}`;
}

function formatDate(value: string): string {
  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return normalizePrintableText(value);
  }

  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(parsedDate);
}

function normalizePrintableText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[‘’‚‛‹›]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/Á/g, 'A')
    .replace(/É/g, 'E')
    .replace(/Í/g, 'I')
    .replace(/Ó/g, 'O')
    .replace(/Ú/g, 'U')
    .replace(/á/g, 'a')
    .replace(/é/g, 'e')
    .replace(/í/g, 'i')
    .replace(/ó/g, 'o')
    .replace(/ú/g, 'u')
    .replace(/Ñ/g, String.fromCharCode(0xa5))
    .replace(/ñ/g, String.fromCharCode(0xa4))
    .replace(/Ü/g, String.fromCharCode(0x9a))
    .replace(/ü/g, String.fromCharCode(0x81))
    .replace(/¿/g, '?')
    .replace(/¡/g, '!')
    .replace(/[^\x0a\x20-\x7e\x81\x9a\xa4\xa5]/g, '');
}

function align(value: Alignment): Buffer {
  const alignmentMap: Record<Alignment, number> = {
    left: 0,
    center: 1,
    right: 2,
  };

  return command(ESC, 0x61, alignmentMap[value]);
}

function centeredSectionLine(value: string, columns: number): Buffer {
  return line(center(value, columns));
}

function center(value: string, width: number): string {
  const printableValue = normalizePrintableText(value);

  if (printableValue.length >= width) {
    return printableValue.slice(0, width);
  }

  const leftPadding = Math.floor((width - printableValue.length) / 2);
  return `${' '.repeat(leftPadding)}${printableValue}`;
}

function line(value: string): Buffer {
  return encodeText(`${value}\n`);
}

function blankLine(): Buffer {
  return encodeText('\n');
}

function feed(lines: number): Buffer {
  return encodeText('\n'.repeat(lines));
}

function command(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

function encodeText(value: string): Buffer {
  const normalizedValue = normalizePrintableText(value);
  const bytes: number[] = [];

  for (const character of normalizedValue) {
    bytes.push(character.charCodeAt(0) & 0xff);
  }

  return Buffer.from(bytes);
}
