// Fetches the real wallet extensions from the Chrome Web Store and unpacks them under
// <repo>/.data/extensions/<name>/ (git-ignored), so a test browser can load them with
// --load-extension. Each unpacked copy keeps the extension's published id: the public key from the
// package header is written into the manifest, which is what the id is derived from.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const EXTENSIONS_DIR = path.resolve(import.meta.dirname, "../../../../../.data/extensions");

/** The wallets the harness knows, by their Chrome Web Store id. */
export const WALLETS = {
  phantom: { id: "bfnaelmomeimhlpmgjnjophhpkkoljpa", label: "Phantom" },
  metamask: { id: "nkbihfbeogaeaoehlefnkodbefgpgknn", label: "MetaMask" },
  solflare: { id: "bhhhlbepdkbapadjdnnojkbgioiodbic", label: "Solflare" },
  backpack: { id: "aflkmfhebedbjioipglgcbcmnbpgliof", label: "Backpack" },
};

const storeUrl = (id, browserVersion) =>
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${browserVersion}&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`;

/** Length-delimited fields of a protocol-buffer message; other field kinds are skipped. */
function* fields(bytes) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  while (offset < bytes.length) {
    const tag = varint();
    const kind = tag % 8;
    if (kind === 2) {
      const length = varint();
      yield { number: Math.floor(tag / 8), value: bytes.subarray(offset, offset + length) };
      offset += length;
    } else if (kind === 0) varint();
    else if (kind === 1) offset += 8;
    else if (kind === 5) offset += 4;
    else throw new Error(`unexpected field kind ${kind} in the package header`);
  }
}

const idOf = (publicKey) =>
  [...createHash("sha256").update(publicKey).digest().subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");

/** Splits a CRX3 package into its zip archive and the public key that gives the extension its id. */
function parsePackage(bytes, expectedId) {
  if (bytes.toString("latin1", 0, 4) !== "Cr24" || bytes.readUInt32LE(4) !== 3) throw new Error("not a CRX3 package");
  const headerLength = bytes.readUInt32LE(8);
  const header = bytes.subarray(12, 12 + headerLength);
  // Field 2 holds the RSA proofs (public key in field 1). Several keys can sign one package; the
  // extension's own key is the one whose hash is the id.
  const keys = [...fields(header)].filter((field) => field.number === 2).map((proof) => [...fields(proof.value)].find((field) => field.number === 1)?.value);
  const publicKey = keys.find((key) => key && idOf(key) === expectedId);
  if (!publicKey) throw new Error(`the package is not signed with the key of ${expectedId}`);
  return { zip: bytes.subarray(12 + headerLength), publicKey };
}

/**
 * Makes sure the wallet's extension is unpacked locally and returns `{ name, id, dir, version }`.
 * An existing copy is reused; pass `refresh` to download the current version again.
 */
export async function ensureExtension(name, { browserVersion, refresh = false } = {}) {
  const wallet = WALLETS[name];
  if (!wallet) throw new Error(`unknown wallet "${name}"; known: ${Object.keys(WALLETS).join(", ")}`);
  const dir = path.join(EXTENSIONS_DIR, name);
  const manifestFile = path.join(dir, "manifest.json");
  if (refresh || !existsSync(manifestFile)) {
    if (!browserVersion) throw new Error("the browser version is needed to download an extension");
    const response = await fetch(storeUrl(wallet.id, browserVersion));
    if (!response.ok) throw new Error(`downloading ${name} failed: HTTP ${response.status}`);
    const { zip, publicKey } = parsePackage(Buffer.from(await response.arrayBuffer()), wallet.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const archive = path.join(EXTENSIONS_DIR, `${name}.zip`);
    writeFileSync(archive, zip);
    try {
      execFileSync("unzip", ["-q", "-o", archive, "-d", dir]);
    } finally {
      rmSync(archive, { force: true });
    }
    // The store's signature folder may not be present in an unpacked extension.
    rmSync(path.join(dir, "_metadata"), { recursive: true, force: true });
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.key = publicKey.toString("base64");
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }
  const { version } = JSON.parse(readFileSync(manifestFile, "utf8"));
  return { name, id: wallet.id, label: wallet.label, dir, version };
}
