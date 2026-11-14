import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressDecoder } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import { ensureKeypairFile, loadKeypairSigner } from "../src/chain/keys.ts";
import { loadKeypairSigner as reExported } from "../src/chain/solana.ts";

const dir = mkdtempSync(join(tmpdir(), "chain-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshKeypair(): { bytes: number[]; address: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { bytes: [...secret, ...pub], address: getAddressDecoder().decode(pub) };
}

describe("loadKeypairSigner", () => {
  it("loads a 64-byte JSON array and signs with it", async () => {
    const keypair = freshKeypair();
    const file = join(dir, "good.json");
    writeFileSync(file, JSON.stringify(keypair.bytes));
    const signer = await loadKeypairSigner(file);
    expect(signer.address).toBe(keypair.address);
    expect(typeof signer.signTransactions).toBe("function");
    expect(reExported).toBe(loadKeypairSigner);
  });

  it("rejects anything that is not a 64-byte array, without echoing the content", async () => {
    const short = join(dir, "short.json");
    writeFileSync(short, JSON.stringify(freshKeypair().bytes.slice(0, 32)));
    await expect(loadKeypairSigner(short)).rejects.toThrow(`${short} is not a 64-byte keypair file`);

    const notBytes = join(dir, "not-bytes.json");
    writeFileSync(notBytes, JSON.stringify(Array.from({ length: 64 }, (_unused, i) => (i === 5 ? 999 : 1))));
    await expect(loadKeypairSigner(notBytes)).rejects.toThrow(`${notBytes} is not a 64-byte keypair file`);

    const object = join(dir, "object.json");
    writeFileSync(object, JSON.stringify({ secret: "hunter2-hunter2" }));
    const error = await loadKeypairSigner(object).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toBe(`${object} is not a 64-byte keypair file`);
    expect(error?.message).not.toContain("hunter2");

    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "hunter2 not json");
    await expect(loadKeypairSigner(garbage)).rejects.toThrow(`${garbage} is not a 64-byte keypair file`);
  });

  it("fails for a missing file", async () => {
    await expect(loadKeypairSigner(join(dir, "missing.json"))).rejects.toThrow(/ENOENT/);
  });
});

describe("ensureKeypairFile", () => {
  it("creates a loadable keypair file with mode 600 and never overwrites one", async () => {
    const file = join(dir, "created-keypair.json");
    expect(await ensureKeypairFile(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const content = readFileSync(file, "utf8");
    expect((JSON.parse(content) as unknown[]).length).toBe(64);
    const signer = await loadKeypairSigner(file);

    expect(await ensureKeypairFile(file)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect((await loadKeypairSigner(file)).address).toBe(signer.address);
  });
});
