import { describe, it, expect } from "vitest";
import { clientOrderIdFor } from "../src/ids.ts";

/** Characters and length the venue accepts for a client order id. */
const VENUE_CLIENT_ORDER_ID = /^[:\-_.#a-zA-Z0-9]{1,36}$/;

function bytesFrom(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe("clientOrderIdFor", () => {
  it("is 'o-' plus the first 32 hex characters of the SHA-256 of the address bytes", () => {
    // Reference digests computed with an independent tool (shasum -a 256).
    // 32 zero bytes: 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
    expect(clientOrderIdFor(new Uint8Array(32))).toBe("o-66687aadf862bd776c8fc18b8e9f8e20");
    // bytes 0x00..0x1f: 630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd
    expect(clientOrderIdFor(Uint8Array.from({ length: 32 }, (_, index) => index))).toBe(
      "o-630dcd2966c4336691125448bbb25b4f",
    );
  });

  it("always produces 34 characters that the venue accepts", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const id = clientOrderIdFor(bytesFrom(seed));
      expect(id).toMatch(/^o-[0-9a-f]{32}$/);
      expect(id).toHaveLength(34);
      expect(id).toMatch(VENUE_CLIENT_ORDER_ID);
    }
  });

  it("is deterministic", () => {
    expect(clientOrderIdFor(bytesFrom(7))).toBe(clientOrderIdFor(bytesFrom(7)));
  });

  it("gives different ids to different addresses", () => {
    const ids = new Set<string>();
    for (let seed = 1; seed <= 1_000; seed += 1) ids.add(clientOrderIdFor(bytesFrom(seed)));
    expect(ids.size).toBe(1_000);

    const oneBitApart = new Uint8Array(32);
    oneBitApart[31] = 1;
    expect(clientOrderIdFor(oneBitApart)).not.toBe(clientOrderIdFor(new Uint8Array(32)));
  });

  it("hashes exactly the 32 bytes of a view into a larger buffer", () => {
    const backing = new Uint8Array(96).fill(0xff);
    backing.fill(0, 32, 64);
    expect(clientOrderIdFor(backing.subarray(32, 64))).toBe("o-66687aadf862bd776c8fc18b8e9f8e20");
    expect(clientOrderIdFor(Buffer.alloc(32))).toBe("o-66687aadf862bd776c8fc18b8e9f8e20");
  });

  it.each([0, 1, 31, 33, 64])("rejects %i bytes", (length) => {
    expect(() => clientOrderIdFor(new Uint8Array(length))).toThrow(RangeError);
  });

  it.each([
    ["an array of 32 numbers", Array.from({ length: 32 }, () => 0)],
    ["a 32-character string", "0".repeat(32)],
    ["an ArrayBuffer", new ArrayBuffer(32)],
    ["a Uint16Array of 32 elements", new Uint16Array(32)],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(() => clientOrderIdFor(value as unknown as Uint8Array)).toThrow(RangeError);
  });
});
