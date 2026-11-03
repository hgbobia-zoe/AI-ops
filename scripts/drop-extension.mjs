// The ONE command to run after any change under extension/:  npm run drop:extension
//
// It builds both variants and puts them where the owner picks them up, named so they can't be mixed up:
//   public/zoe-autopull-extension.zip                     keyed, committed + served by the app (CI checks it)
//   <drop>/zoe-autopull-extension/                        keyed, unpacked, for chrome://extensions "Load unpacked"
//   <drop>/UPLOAD-TO-CHROME-WEB-STORE-v<version>.zip      KEYLESS, the only file to upload in the Developer Console
// <drop> is EXT_DROP_DIR, default C:\Git. Older store zips and the old ambiguous <drop>/zoe-autopull-extension.zip
// are removed so the folder never offers a keyed zip for the store upload ("key field value in the manifest
// doesn't match the current item" is what the store says when it gets the keyed one).
//
// It refuses to run when extension/manifest.json still has the version of the last drop: bump it first, or a
// reload in Chrome gives no sign the new code took and the store rejects a same-version upload.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DROP = process.env.EXT_DROP_DIR || "C:\\Git";
const version = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8")).version;
const STAMP = join(DROP, ".zoe-autopull-last-drop");
const storeName = `UPLOAD-TO-CHROME-WEB-STORE-v${version}.zip`;

if (!existsSync(DROP)) {
  console.error(`drop-extension: ${DROP} does not exist (set EXT_DROP_DIR)`);
  process.exit(1);
}
const last = existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : null;
if (last === version && !process.argv.includes("--same-version")) {
  console.error(`drop-extension: version ${version} was already dropped. Bump extension/manifest.json first (or pass --same-version).`);
  process.exit(1);
}

const build = (...args) => execFileSync(process.execPath, [join(ROOT, "scripts", "build-extension.mjs"), ...args], { stdio: "inherit" });

// 1) keyed, committed + served
build();
// 2) keyless store upload
for (const f of readdirSync(DROP)) {
  if (/^UPLOAD-TO-CHROME-WEB-STORE-v.*\.zip$/.test(f) || f === "zoe-autopull-extension.zip") rmSync(join(DROP, f), { force: true });
}
build("--store", "--out", join(DROP, storeName));
// 3) keyed, unpacked for Load unpacked
const unpacked = join(DROP, "zoe-autopull-extension");
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
for (const f of readdirSync(join(ROOT, "extension"))) {
  if (f.startsWith(".") || !statSync(join(ROOT, "extension", f)).isFile()) continue;
  writeFileSync(join(unpacked, f), readFileSync(join(ROOT, "extension", f)));
}

// verify: the store zip must not carry a key, the unpacked copy must
const storeBytes = readFileSync(join(DROP, storeName)).toString("latin1");
if (/"key"\s*:\s*"MII/.test(storeBytes)) {
  console.error("drop-extension: the store zip still has a manifest key. Not safe to upload.");
  process.exit(1);
}
writeFileSync(STAMP, version + "\n");
console.log(`\nDropped v${version}:\n  Chrome Web Store upload: ${join(DROP, storeName)}\n  Load unpacked:           ${unpacked}`);
