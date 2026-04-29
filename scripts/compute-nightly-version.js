const fs = require('fs');
const path = require('path');

/**
 * VS Marketplace and Open VSX only accept `major.minor.patch` (no SemVer
 * prerelease tags like `-nightly`). For `vsce publish --pre-release`, use an
 * **odd** middle number; stable releases use an **even** middle number.
 *
 * @see https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions
 *
 * Base `X.Y.Z` is taken from the part before the first hyphen in package.json
 * (e.g. `1.2.3-nightly` -> 1.2.3). The published pre-release version is
 * `X.Yodd.Z` where Yodd is Y if Y is already odd, else Y+1.
 *
 * @param {string} packageVersion value from package.json
 * @returns {string}
 */
function computeNightlyVersion(packageVersion) {
  const [maj, min, pat] = parseBaseSemver(packageVersion);
  const preReleaseMinor = min % 2 === 0 ? min + 1 : min;
  return `${maj}.${preReleaseMinor}.${pat}`;
}

/**
 * @param {string} versionField
 * @returns {[number, number, number]}
 */
function parseBaseSemver(versionField) {
  if (typeof versionField !== 'string') {
    throw new Error('package.json version must be a string');
  }
  const core = versionField.split('-')[0];
  const parts = core.split('.');
  if (parts.length !== 3) {
    throw new Error(`Expected major.minor.patch before first hyphen, got: ${versionField}`);
  }
  const nums = parts.map((p) => {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(`Invalid semver segment in version: ${versionField}`);
    }
    return n;
  });
  return [nums[0], nums[1], nums[2]];
}

function main() {
  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  process.stdout.write(computeNightlyVersion(pkg.version));
}

module.exports = { computeNightlyVersion, parseBaseSemver };

if (require.main === module) {
  main();
}
