import assert from 'node:assert/strict';

import {
  coldBuildLauncherExecutableIdentity,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

function syntheticElf({
  bits,
  endian,
  machine,
  osAbi,
  programHeaderType,
}) {
  const is64Bit = bits === 64;
  const littleEndian = endian === 'little';
  const programHeaderOffset = is64Bit ? 64 : 52;
  const programHeaderEntrySize = is64Bit ? 56 : 32;
  const bytes = Buffer.alloc(programHeaderOffset + programHeaderEntrySize);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  bytes[4] = is64Bit ? 2 : 1;
  bytes[5] = littleEndian ? 1 : 2;
  bytes[6] = 1;
  bytes[7] = osAbi;
  const writeUInt16 = (value, offset) => (
    littleEndian
      ? bytes.writeUInt16LE(value, offset)
      : bytes.writeUInt16BE(value, offset)
  );
  const writeUInt32 = (value, offset) => (
    littleEndian
      ? bytes.writeUInt32LE(value, offset)
      : bytes.writeUInt32BE(value, offset)
  );
  writeUInt16(machine, 18);
  if (is64Bit) {
    if (littleEndian) bytes.writeBigUInt64LE(BigInt(programHeaderOffset), 32);
    else bytes.writeBigUInt64BE(BigInt(programHeaderOffset), 32);
  } else {
    writeUInt32(programHeaderOffset, 28);
  }
  writeUInt16(programHeaderEntrySize, is64Bit ? 54 : 42);
  writeUInt16(1, is64Bit ? 56 : 44);
  writeUInt32(programHeaderType, programHeaderOffset);
  return bytes;
}

const first = coldBuildLauncherExecutableIdentity(syntheticElf({
  bits: 32,
  endian: 'little',
  machine: 3,
  osAbi: 0,
  programHeaderType: 1,
}));
assert.deepEqual(first, {
  formatIdentity: 'elf:32:little-endian:osabi-0',
  machineIdentity: 'elf-machine:3',
  staticExecutable: true,
  programHeaderTypes: [1],
});

const second = coldBuildLauncherExecutableIdentity(syntheticElf({
  bits: 64,
  endian: 'big',
  machine: 0x1234,
  osAbi: 9,
  programHeaderType: 3,
}));
assert.deepEqual(second, {
  formatIdentity: 'elf:64:big-endian:osabi-9',
  machineIdentity: 'elf-machine:4660',
  staticExecutable: false,
  programHeaderTypes: [3],
});

assert.equal(coldBuildLauncherExecutableIdentity(Buffer.alloc(64)), null);
const truncatedElf64 = Buffer.alloc(52);
truncatedElf64.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
assert.equal(coldBuildLauncherExecutableIdentity(truncatedElf64), null);

console.log(JSON.stringify({
  status: 'self_check_passed',
  openMachineIdentityAccepted: true,
  elfClassAndByteOrderObserved: true,
}, null, 2));
