const fs = require('node:fs');
const path = require('node:path');

exports.default = async function verifyPackagedPrinter(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const packageRoot = path.join(
    context.appOutDir,
    'resources',
    'printer-runtime',
  );
  const modulePath = path.join(packageRoot, 'lib', 'printer.js');
  const binaryCandidates = [
    path.join(packageRoot, 'build', 'Release', 'node_printer.node'),
    path.join(packageRoot, 'lib', 'node_printer.node'),
  ];
  const binaryPath = binaryCandidates.find((candidate) => fs.existsSync(candidate));
  const missingPaths = [
    path.join(packageRoot, 'package.json'),
    modulePath,
  ].filter((candidate) => !fs.existsSync(candidate));

  if (!binaryPath) {
    missingPaths.push(...binaryCandidates);
  }

  if (missingPaths.length > 0) {
    throw new Error(
      `El paquete Windows no contiene el runtime printer requerido: ${missingPaths.join(', ')}`,
    );
  }

  console.log('[verify-packaged-printer] Runtime printer incluido.', {
    modulePath,
    binaryPath,
  });
};
