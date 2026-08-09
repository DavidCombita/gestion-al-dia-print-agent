const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const verifyPackagedPrinter = require('../scripts/verify-packaged-printer.js').default;

test('rejects a Windows package that omits the printer runtime', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gad-printer-package-'));

  try {
    await assert.rejects(
      verifyPackagedPrinter({ electronPlatformName: 'win32', appOutDir }),
      /no contiene el runtime printer requerido/,
    );
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('accepts a Windows package with the wrapper and native binary unpacked', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gad-printer-package-'));
  const packageRoot = path.join(
    appOutDir,
    'resources',
    'printer-runtime',
  );

  try {
    fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
    fs.writeFileSync(path.join(packageRoot, 'lib', 'printer.js'), 'module.exports = {};');
    fs.writeFileSync(
      path.join(packageRoot, 'build', 'Release', 'node_printer.node'),
      'native-placeholder',
    );

    await assert.doesNotReject(
      verifyPackagedPrinter({ electronPlatformName: 'win32', appOutDir }),
    );
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});
