const fs = require('node:fs');
const path = require('node:path');

const printerWinSourcePath = path.join(
  __dirname,
  '..',
  'node_modules',
  'printer',
  'src',
  'node_printer_win.cc',
);
const printerPackageRoot = path.join(__dirname, '..', 'node_modules', 'printer');
const printerLibDirectory = path.join(printerPackageRoot, 'lib');
const printerBuildReleaseBinary = path.join(
  printerPackageRoot,
  'build',
  'Release',
  'node_printer.node',
);
const printerLibBinary = path.join(printerLibDirectory, 'node_printer.node');
const printerLibIndex = path.join(printerLibDirectory, 'index.js');
const printerLibPrinter = path.join(printerLibDirectory, 'printer.js');

if (!fs.existsSync(printerPackageRoot)) {
  console.log('[patch-printer] printer no esta instalado. No hay nada para parchear.');
  process.exit(0);
}

patchWindowsSource();
ensureLibRuntimeFiles();

function patchWindowsSource() {
  if (!fs.existsSync(printerWinSourcePath)) {
    console.log('[patch-printer] No existe node_printer_win.cc. Se omite el parche de C++.');
    return;
  }

  const originalSource = fs.readFileSync(printerWinSourcePath, 'utf8');
  let patchedSource = originalSource
    .replace(
      /(?:this->)*_value = \(Type\*\)malloc\(iSizeKbytes\);/,
      'this->_value = (Type*)malloc(iSizeKbytes);',
    )
    .replace(/if\((?:this->)*_value != NULL\)/, 'if(this->_value != NULL)')
    .replace(/::free\((?:this->)*_value\);/, '::free(this->_value);')
    .replace(/(?:this->)*_value = NULL;/, 'this->_value = NULL;');

  if (!patchedSource.includes('"statusNumber", V8_VALUE_NEW(Number, job->Status)')) {
    patchedSource = patchedSource.replace(
      'MY_NODE_SET_OBJECT_PROP(result_printer_job, "status", result_printer_job_status);',
      [
        'MY_NODE_SET_OBJECT_PROP(result_printer_job, "status", result_printer_job_status);',
        '        MY_NODE_SET_OBJECT_PROP(result_printer_job, "statusNumber", V8_VALUE_NEW(Number, job->Status));',
      ].join('\n'),
    );
  }

  if (patchedSource === originalSource) {
    console.log('[patch-printer] Los parches C++ ya estaban aplicados.');
    return;
  }

  fs.writeFileSync(printerWinSourcePath, patchedSource, 'utf8');
  console.log('[patch-printer] Parche aplicado sobre node_modules/printer/src/node_printer_win.cc');
}

function ensureLibRuntimeFiles() {
  fs.mkdirSync(printerLibDirectory, { recursive: true });

  if (fs.existsSync(printerBuildReleaseBinary) && !fs.existsSync(printerLibBinary)) {
    fs.copyFileSync(printerBuildReleaseBinary, printerLibBinary);
    console.log('[patch-printer] Copiado node_printer.node desde build/Release hacia lib/.');
  }

  if (!fs.existsSync(printerLibIndex)) {
    console.log('[patch-printer] Creando lib/index.js.');
  }
  fs.writeFileSync(printerLibIndex, "module.exports = require('./printer');\n", 'utf8');

  fs.writeFileSync(
    printerLibPrinter,
    [
      'const path = require("node:path");',
      '',
      'const binaryPath = path.join(__dirname, "node_printer.node");',
      'const nativePrinter = require(binaryPath);',
      '',
      'function printDirect(options) {',
      '  if (!options || typeof options !== "object") {',
      '    throw new Error("printDirect requiere un objeto de opciones.");',
      '  }',
      '',
      '  const printerName =',
      '    typeof options.printer === "string" && options.printer.trim()',
      '      ? options.printer.trim()',
      '      : nativePrinter.getDefaultPrinterName();',
      '  const docname =',
      '    typeof options.docname === "string" && options.docname.trim()',
      '      ? options.docname.trim()',
      '      : "Gestion al Dia Print Agent";',
      '  const type =',
      '    typeof options.type === "string" && options.type.trim()',
      '      ? options.type.trim()',
      '      : "RAW";',
      '',
      '  try {',
      '    const jobId = nativePrinter.printDirect(',
      '      options.data,',
      '      printerName,',
      '      docname,',
      '      type,',
      '      options.options || {},',
      '    );',
      '',
      '    if (typeof options.success === "function") {',
      '      options.success(jobId);',
      '    }',
      '',
      '    return jobId;',
      '  } catch (error) {',
      '    if (typeof options.error === "function") {',
      '      options.error(error);',
      '      return null;',
      '    }',
      '',
      '    throw error;',
      '  }',
      '}',
      '',
      'module.exports = {',
      '  ...nativePrinter,',
      '  printDirect,',
      '  __gestionAlDiaModuleInfo: {',
      '    modulePath: __filename,',
      '    binaryPath,',
      '    mode: "package-wrapper",',
      '  },',
      '};',
    ].join('\n') + '\n',
    'utf8',
  );
  console.log('[patch-printer] Actualizado lib/printer.js.');
}
