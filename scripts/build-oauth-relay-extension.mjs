import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const rootDir = process.cwd();
const sourceDir = path.join(rootDir, 'extensions', 'synthi-oauth-relay');
const publicDir = path.join(rootDir, 'synthi', 'public', 'extensions');
const unpackedDir = path.join(publicDir, 'synthi-oauth-relay');

const files = [
  'manifest.json',
  'background.js',
  'content-bridge.js',
  'README.md',
];

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date('2026-01-01T00:00:00Z')) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosTime, dosDate };
}

function assertSafeManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error('Synthi OAuth Relay extension must use Manifest V3.');
  }
  if (!manifest.background?.service_worker) {
    throw new Error('Manifest must define a background service worker.');
  }
  const permissions = new Set(manifest.permissions || []);
  for (const required of ['webNavigation', 'storage']) {
    if (!permissions.has(required)) {
      throw new Error(`Manifest is missing required permission: ${required}`);
    }
  }
  const hostPermissions = manifest.host_permissions || [];
  for (const host of hostPermissions) {
    if (host === '<all_urls>' || host.includes('*://') || host.includes('http://')) {
      throw new Error(`Over-broad host permission is not allowed: ${host}`);
    }
  }
}

function createZip(entries) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll(path.sep, '/'));
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuffer = Buffer.concat(centralDirectory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(sourceDir, 'manifest.json'), 'utf8'));
  assertSafeManifest(manifest);

  await rm(unpackedDir, { recursive: true, force: true });
  await mkdir(unpackedDir, { recursive: true });

  const entries = [];
  for (const file of files) {
    const data = await readFile(path.join(sourceDir, file));
    await writeFile(path.join(unpackedDir, file), data);
    entries.push({ name: file, data });
  }

  const zip = createZip(entries);
  const versionedZipPath = path.join(publicDir, `synthi-oauth-relay-v${manifest.version}.zip`);
  const stableZipPath = path.join(publicDir, 'synthi-oauth-relay.zip');
  await writeFile(versionedZipPath, zip);
  await writeFile(stableZipPath, zip);

  console.log(`Built Synthi OAuth Relay extension v${manifest.version}`);
  console.log(`Unpacked: ${path.relative(rootDir, unpackedDir)}`);
  console.log(`Zip:      ${path.relative(rootDir, versionedZipPath)}`);
  console.log(`Stable:   ${path.relative(rootDir, stableZipPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
