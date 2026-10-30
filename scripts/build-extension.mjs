// Rebuild the downloadable browser-extension zip the app serves at /zoe-autopull-extension.zip from the
// source in extension/. Wired as the npm `prebuild` step, so EVERY build (crucially every Docker deploy,
// which runs `npm run build`) regenerates it — the served extension can never drift from extension/. Run it
// by hand with `npm run build:extension`.
//
// Pure Node (fs only): no dependency, works identically on Windows dev and the Linux build image. Entries
// are STORED (no compression) so the output is byte-identical on every platform and Node version — there is
// no deflate/zlib variance — which lets CI reliably fail a PR whose committed zip is stale vs extension/.
// Deterministic: files are sorted and stamped with a fixed DOS timestamp, so the bytes change ONLY when
// extension/ content changes (a re-run on unchanged sources yields an identical zip).

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension");

// Args (both optional; default behavior is unchanged — the committed served zip):
//   --store          Build the CHROME WEB STORE variant: strip manifest "key" so the store owns the id
//                    (amjncl…). The committed key resolves to the OLD unpacked id (mpneeiibe…); uploading a
//                    zip carrying it to the store item is rejected on id mismatch. The publish-extension CI
//                    job calls this; the committed/served zip (no flag) keeps the key untouched.
//   --out <path>     Write the zip here instead of public/zoe-autopull-extension.zip (used by CI to emit a
//                    throwaway store zip it does not commit). Relative paths resolve against the repo root.
const argv = process.argv.slice(2);
const STORE = argv.includes("--store");
const outFlagIdx = argv.indexOf("--out");
const outArg = outFlagIdx >= 0 ? argv[outFlagIdx + 1] : null;
if (outFlagIdx >= 0 && !outArg) {
  console.error("build-extension: --out requires a path");
  process.exit(1);
}
const OUT = outArg ? (isAbsolute(outArg) ? outArg : join(ROOT, outArg)) : join(ROOT, "public", "zoe-autopull-extension.zip");

// Fixed DOS date/time (1980-01-01 00:00:00) for reproducible output.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The extension's own files only (flat, like Chrome expects). Skip dotfiles and any stray subdirectories so
// a local .DS_Store / editor junk never lands in the shipped zip. Sorted for a deterministic archive.
const names = readdirSync(SRC)
  .filter((n) => !n.startsWith("."))
  .filter((n) => statSync(join(SRC, n)).isFile())
  .sort();

// Normalize text files to LF so the zip bytes are identical no matter a contributor's git autocrlf setting
// (a Windows working tree may hold CRLF while Linux CI checks out LF — that would otherwise flip CRC32 and
// make the staleness guard false-fail). Binaries (png) are byte-for-byte untouched.
const TEXT_EXT = new Set([".js", ".json", ".html", ".css", ".md", ".txt", ".svg"]);
function contentOf(name) {
  const data = readFileSync(join(SRC, name));
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (!TEXT_EXT.has(ext)) return data;
  let text = data.toString("utf8").replace(/\r\n/g, "\n");
  // Store variant: drop the manifest "key". The store item (amjncl…) owns the id, so the upload must NOT
  // carry the committed key (which resolves to the retired unpacked id mpneeiibe…) or it is rejected.
  if (STORE && name === "manifest.json") {
    const manifest = JSON.parse(text);
    delete manifest.key;
    text = JSON.stringify(manifest, null, 2) + "\n";
  }
  return Buffer.from(text, "utf8");
}

const locals = [];
const central = [];
let offset = 0;

for (const name of names) {
  const data = contentOf(name);
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: store (no compression)
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size == uncompressed (stored)
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length
  nameBuf.copy(local, 30);
  locals.push(local, data);

  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0); // central dir header signature
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(0, 10); // method: store (no compression)
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20); // compressed size == uncompressed (stored)
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); // extra length
  cd.writeUInt16LE(0, 32); // comment length
  cd.writeUInt16LE(0, 34); // disk number start
  cd.writeUInt16LE(0, 36); // internal attrs
  cd.writeUInt32LE(0, 38); // external attrs
  cd.writeUInt32LE(offset, 42); // local header offset
  nameBuf.copy(cd, 46);
  central.push(cd);

  offset += local.length + data.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
eocd.writeUInt16LE(0, 4); // disk number
eocd.writeUInt16LE(0, 6); // disk with central dir
eocd.writeUInt16LE(names.length, 8); // entries on this disk
eocd.writeUInt16LE(names.length, 10); // total entries
eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
eocd.writeUInt32LE(offset, 16); // central dir offset
eocd.writeUInt16LE(0, 20); // comment length

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([...locals, centralBuf, eocd]));
console.log(`built ${OUT} — ${names.length} files${STORE ? " (store variant: manifest key stripped)" : ""}`);
