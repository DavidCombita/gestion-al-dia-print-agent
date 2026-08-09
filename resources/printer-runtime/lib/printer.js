const fs = require('node:fs');
const path = require('node:path');

const binaryCandidates = [
  path.join(__dirname, '..', 'build', 'Release', 'node_printer.node'),
  path.join(__dirname, 'node_printer.node'),
];
const binaryPath = binaryCandidates.find((candidate) => fs.existsSync(candidate));

if (!binaryPath) {
  throw new Error(
    `No se encontro node_printer.node. Rutas revisadas: ${binaryCandidates.join(', ')}`,
  );
}

const nativePrinter = require(binaryPath);

function printDirect(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('printDirect requiere un objeto de opciones.');
  }

  const printerName =
    typeof options.printer === 'string' && options.printer.trim()
      ? options.printer.trim()
      : nativePrinter.getDefaultPrinterName();
  const docname =
    typeof options.docname === 'string' && options.docname.trim()
      ? options.docname.trim()
      : 'Gestion al Dia Print Agent';
  const type =
    typeof options.type === 'string' && options.type.trim()
      ? options.type.trim()
      : 'RAW';

  try {
    const jobId = nativePrinter.printDirect(
      options.data,
      printerName,
      docname,
      type,
      options.options || {},
    );

    if (typeof options.success === 'function') {
      options.success(jobId);
    }

    return jobId;
  } catch (error) {
    if (typeof options.error === 'function') {
      options.error(error);
      return null;
    }

    throw error;
  }
}

module.exports = {
  ...nativePrinter,
  printDirect,
  __gestionAlDiaModuleInfo: {
    modulePath: __filename,
    binaryPath,
    mode: 'package-wrapper',
  },
};
