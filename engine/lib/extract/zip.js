/* A ZIP reader: enough of the format to open a .docx.
 *
 * The central directory at the end of the file is the index - local headers
 * can carry zero sizes when a writer streamed the entry - so entries are found
 * there and only their data is read from the local header onwards. Stored and
 * deflated entries are all a .docx uses; ZIP64 and encryption are refused by
 * name rather than misread.
 */
import zlib from 'node:zlib';
import { ExtractError } from './errors.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/* A small file can inflate to gigabytes. Nothing a document needs is this
 * large, so inflating stops here instead of exhausting memory (t-afff7cc35c). */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

function findEocd(buf) {
  // The record is 22 bytes plus a comment of up to 65535.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

export function readZip(buf) {
  if (buf.length < 22) throw new ExtractError('corrupt', 'The file is too short to be a ZIP archive.');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ExtractError('corrupt', 'No ZIP directory found - the file is damaged or not a .docx.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new ExtractError('unsupported', 'ZIP64 archives are not supported.');
  }
  if (cdOffset + cdSize > buf.length) throw new ExtractError('corrupt', 'The ZIP directory points past the end of the file.');

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) {
      throw new ExtractError('corrupt', 'The ZIP directory is damaged.');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    // Bit 11 says the name is UTF-8; otherwise it is CP437, which for the
    // ASCII names inside a .docx reads the same.
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    entries.set(name, { name, flags, method, compSize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.flags & 0x1) throw new ExtractError('encrypted', 'The document is password-protected.');
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== LOCAL) {
        throw new ExtractError('corrupt', `The ZIP entry ${name} is damaged.`);
      }
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.size > MAX_ENTRY_BYTES) throw new ExtractError('too-large', `${name} would inflate past ${MAX_ENTRY_BYTES} bytes.`);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
        } catch (err) {
          throw new ExtractError('corrupt', `The ZIP entry ${name} could not be inflated: ${err.message}`);
        }
      }
      throw new ExtractError('unsupported', `ZIP compression method ${e.method} is not supported.`);
    },
  };
}
