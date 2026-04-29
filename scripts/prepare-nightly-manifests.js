const fs = require('fs');
const path = require('path');
const { computeNightlyVersion } = require('./compute-nightly-version.js');

function ensureNightlySuffix(description) {
  const suffix = ' [Nightly]';
  if (typeof description !== 'string') {
    return suffix.trim();
  }
  return description.includes(suffix) ? description : `${description}${suffix}`;
}

function main() {
  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const outDir = path.join(root, '.nightly');

  if (!fs.existsSync(pkgPath)) {
    throw new Error('package.json not found in repository root');
  }

  const basePackage = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const nightlyVersion =
    process.env.NIGHTLY_VERSION ||
    computeNightlyVersion(basePackage.version);

  const openVsxNightlyName = process.env.OPENVSX_NIGHTLY_NAME || 'postgres-explorer-nightly';

  const marketplaceNightly = {
    ...basePackage,
    version: nightlyVersion,
    description: ensureNightlySuffix(basePackage.description),
  };

  const openVsxNightly = {
    ...basePackage,
    name: openVsxNightlyName,
    displayName: `${basePackage.displayName} Nightly`,
    version: nightlyVersion,
    description: ensureNightlySuffix(basePackage.description),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'package.marketplace.json'),
    `${JSON.stringify(marketplaceNightly, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, 'package.openvsx.json'),
    `${JSON.stringify(openVsxNightly, null, 2)}\n`,
    'utf8'
  );

  process.stdout.write(`Generated nightly manifests for version ${nightlyVersion}\n`);
}

main();
