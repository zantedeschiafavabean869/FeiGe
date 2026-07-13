const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const root = path.resolve(__dirname, '..');
const releaseRoot = path.join(root, 'release');
const version = require(path.join(root, 'package.json')).version;
const buildRoot = path.join(releaseRoot, `build-${version}-final`);
const unpacked = path.join(buildRoot, 'win-unpacked');
const finalDir = path.join(releaseRoot, `FeiGe-${version}`);
const zipPath = path.join(releaseRoot, `FeiGe-${version}-Windows-绿色版.zip`);

function assertInsideRelease(target) {
  const resolved = path.resolve(target);
  if (resolved !== releaseRoot && !resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error(`Refusing operation outside release directory: ${resolved}`);
  }
}

async function removeSafe(target) {
  assertInsideRelease(target);
  await fsp.rm(target, { recursive: true, force: true });
}

async function zipDirectory(sourceDir, outputFile) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, path.basename(sourceDir));
    archive.finalize();
  });
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

async function main() {
  assertInsideRelease(unpacked);
  if (!fs.existsSync(path.join(unpacked, 'FeiGe.exe'))) throw new Error('Packaged FeiGe.exe was not found.');

  await removeSafe(path.join(unpacked, 'FeiGeData'));
  await fsp.copyFile(path.join(root, 'README.md'), path.join(unpacked, 'README.md'));
  await fsp.copyFile(path.join(root, 'LICENSE'), path.join(unpacked, 'LICENSE'));
  await fsp.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(unpacked, 'THIRD_PARTY_NOTICES.md'));
  await fsp.cp(path.join(root, 'docs'), path.join(unpacked, 'docs'), { recursive: true });

  await removeSafe(finalDir);
  await fsp.rename(unpacked, finalDir);
  await removeSafe(zipPath);
  await zipDirectory(finalDir, zipPath);

  const result = {
    version,
    folder: finalDir,
    zip: zipPath,
    zipBytes: (await fsp.stat(zipPath)).size,
    sha256: await sha256(zipPath)
  };
  await fsp.writeFile(path.join(releaseRoot, `FeiGe-${version}-SHA256.txt`), `${result.sha256}  ${path.basename(zipPath)}\n`, 'utf8');
  await fsp.writeFile(path.join(releaseRoot, `FeiGe-${version}-release.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  for (const oldName of ['FeiGe-0.3.0', 'FeiGe-0.3.0-Windows-绿色版.zip', 'staging-0.4.0', buildRoot]) {
    const oldPath = path.isAbsolute(oldName) ? oldName : path.join(releaseRoot, oldName);
    if (path.resolve(oldPath) !== path.resolve(finalDir)) await removeSafe(oldPath);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
