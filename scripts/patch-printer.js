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

if (!fs.existsSync(printerWinSourcePath)) {
  console.log('[patch-printer] printer no esta instalado. No hay nada para parchear.');
  process.exit(0);
}

const originalSource = fs.readFileSync(printerWinSourcePath, 'utf8');

if (originalSource.includes('this->_value')) {
  console.log('[patch-printer] El parche ya estaba aplicado.');
  process.exit(0);
}

const patchedSource = originalSource
  .replace('_value = (Type*)malloc(iSizeKbytes);', 'this->_value = (Type*)malloc(iSizeKbytes);')
  .replace('if(_value != NULL)', 'if(this->_value != NULL)')
  .replace('::free(_value);', '::free(this->_value);')
  .replace('_value = NULL;', 'this->_value = NULL;');

if (patchedSource === originalSource) {
  console.warn('[patch-printer] No encontre los patrones esperados en node_printer_win.cc.');
  process.exit(0);
}

fs.writeFileSync(printerWinSourcePath, patchedSource, 'utf8');
console.log('[patch-printer] Parche aplicado sobre node_modules/printer/src/node_printer_win.cc');
