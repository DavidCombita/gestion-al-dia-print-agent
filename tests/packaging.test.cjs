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

test('materializes a missing wrapper after rebuild and accepts the Windows package', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gad-printer-package-'));
  const packageRoot = path.join(
    appOutDir,
    'resources',
    'printer-runtime',
  );

  try {
    fs.mkdirSync(path.join(packageRoot, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(packageRoot, 'build', 'Release', 'node_printer.node'),
      'native-placeholder',
    );
    assert.equal(fs.existsSync(path.join(packageRoot, 'lib', 'printer.js')), false);

    await assert.doesNotReject(
      verifyPackagedPrinter({ electronPlatformName: 'win32', appOutDir }),
    );
    assert.equal(
      fs.readFileSync(path.join(packageRoot, 'lib', 'printer.js'), 'utf8'),
      fs.readFileSync(
        path.join(
          __dirname,
          '..',
          'resources',
          'printer-runtime',
          'lib',
          'printer.js',
        ),
        'utf8',
      ),
    );
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});
