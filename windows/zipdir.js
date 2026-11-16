'use strict';

/**
 * A tiny ZIP writer with no dependencies, so the same code produces backups on
 * Windows and on the Linux box used for development. Files under 64 MiB are
 * deflated, anything larger is stored, which keeps a big uploads folder from
 * turning a backup into a CPU spike.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const STORE_LIMIT = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

function walk(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
    }
  }
  return out;
}

/**
 * Zips every file under `srcDir` into `outFile` (written through a .part file, so
 * a crash never leaves a half-written archive that looks valid).
 * Returns { entries, sourceBytes, archiveBytes }.
 */
function writeZipDir(srcDir, outFile) {
  const files = walk(srcDir, srcDir, []);
  const chunks = [];
  const central = [];
  let offset = 0;
  let sourceBytes = 0;

  for (const file of files) {
    const info = fs.statSync(file.full);
    const data = fs.readFileSync(file.full);
    sourceBytes += data.length;

    const deflate = data.length <= STORE_LIMIT;
    const body = deflate ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const crc = crc32(data);
    const name = Buffer.from(file.rel, 'utf8');
    const stamp = dosStamp(info.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 20 : 10, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(deflate ? 20 : 10, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...chunks, directory, end]);
  const part = `${outFile}.part`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(part, archive);
  fs.renameSync(part, outFile);

  return { entries: files.length, sourceBytes, archiveBytes: archive.length };
}

module.exports = { writeZipDir };
