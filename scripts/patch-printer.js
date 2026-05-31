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

  if (originalSource.includes('this->_value')) {
    console.log('[patch-printer] El parche C++ ya estaba aplicado.');
    return;
  }

  const patchedSource = originalSource
    .replace('_value = (Type*)malloc(iSizeKbytes);', 'this->_value = (Type*)malloc(iSizeKbytes);')
    .replace('if(_value != NULL)', 'if(this->_value != NULL)')
    .replace('::free(_value);', '::free(this->_value);')
    .replace('_value = NULL;', 'this->_value = NULL;');

  if (patchedSource === originalSource) {
    console.warn('[patch-printer] No encontre los patrones esperados en node_printer_win.cc.');
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
    fs.writeFileSync(printerLibIndex, "module.exports = require('./printer');\n", 'utf8');
    console.log('[patch-printer] Creado lib/index.js.');
  }

  if (!fs.existsSync(printerLibPrinter)) {
    fs.writeFileSync(
      printerLibPrinter,
      [
        'const path = require("node:path");',
        '',
        'const candidateBinaries = [',
        '  path.join(__dirname, "node_printer.node"),',
        '  path.join(__dirname, "..", "build", "Release", "node_printer.node"),',
        '];',
        '',
        'let lastError = null;',
        '',
        'for (const candidateBinary of candidateBinaries) {',
        '  try {',
        '    module.exports = require(candidateBinary);',
        '    return;',
        '  } catch (error) {',
        '    lastError = error;',
        '  }',
        '}',
        '',
        'throw lastError || new Error("No fue posible cargar node_printer.node");',
      ].join('\n') + '\n',
      'utf8',
    );
    console.log('[patch-printer] Creado lib/printer.js.');
  }
}
