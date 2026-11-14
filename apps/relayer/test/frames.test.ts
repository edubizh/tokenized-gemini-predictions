import { describe, it, expect, vi } from "vitest";
import { parseFrame } from "../src/venue/frames.ts";

describe("parseFrame: JSON level", () => {
  it.each([
    ["an empty frame", ""],
    ["a truncated object", '{"e":"orderUpdate","i":7000'],
    ["plain text", "not json"],
    ["single quotes", "{'a':1}"],
    ["a trailing comma", "[1,]"],
    ["a bare identifier", "undefined"],
    ["a number with a leading zero", '{"a":01}'],
    ["a long integer used as a key", '{1234567890123456789:1}'],
    ["a long integer with a leading zero", '{"a":01234567890123456789}'],
    ["two values", '{"a":1}{"b":2}'],
  ])("reports %s as malformed and keeps the raw text", (_label, raw) => {
    expect(parseFrame(raw)).toEqual({ kind: "malformed", raw });
  });

  it("reports valid JSON of an unrecognised shape as unknown", () => {
    expect(parseFrame('{"hello":"world"}')).toEqual({ kind: "unknown", value: { hello: "world" } });
    expect(parseFrame("[1,2,3]")).toEqual({ kind: "unknown", value: [1, 2, 3] });
    expect(parseFrame('"text"')).toEqual({ kind: "unknown", value: "text" });
    expect(parseFrame("42")).toEqual({ kind: "unknown", value: 42 });
    expect(parseFrame("null")).toEqual({ kind: "unknown", value: null });
    expect(parseFrame("true")).toEqual({ kind: "unknown", value: true });
    expect(parseFrame('{"e":"somethingNew","x":1.5}')).toEqual({
      kind: "unknown",
      value: { e: "somethingNew", x: 1.5 },
    });
  });
});

describe("parseFrame: lossless integers", () => {
  it("keeps integers of 16 or more digits as strings", () => {
    expect(parseFrame('{"a":700000000000000001}')).toEqual({ kind: "unknown", value: { a: "700000000000000001" } });
    expect(parseFrame('{"a":1234567890123456}')).toEqual({ kind: "unknown", value: { a: "1234567890123456" } });
    expect(parseFrame('{"a":-1234567890123456}')).toEqual({ kind: "unknown", value: { a: "-1234567890123456" } });
    expect(parseFrame("1794624000000000000")).toEqual({ kind: "unknown", value: "1794624000000000000" });
    // 2^53 + 1 has no exact Number representation.
    expect(parseFrame("[9007199254740993]")).toEqual({ kind: "unknown", value: ["9007199254740993"] });
  });

  it("keeps shorter integers as numbers", () => {
    expect(parseFrame('{"a":123456789012345,"b":0,"c":-42,"d":200}')).toEqual({
      kind: "unknown",
      value: { a: 123_456_789_012_345, b: 0, c: -42, d: 200 },
    });
  });

  it("converts long integers at any depth", () => {
    const raw = '{"a":[{"b":700000000000000001},[700000000000000002,3]],"c":{"d":{"e":700000000000000003}}}';
    expect(parseFrame(raw)).toEqual({
      kind: "unknown",
      value: {
        a: [{ b: "700000000000000001" }, ["700000000000000002", 3]],
        c: { d: { e: "700000000000000003" } },
      },
    });
  });

  it("leaves digits inside strings alone", () => {
    const raw = '{"m":"x: 1234567890123456789, y","n":"[1234567890123456789]","k":"1234567890123456789"}';
    expect(parseFrame(raw)).toEqual({
      kind: "unknown",
      value: { m: "x: 1234567890123456789, y", n: "[1234567890123456789]", k: "1234567890123456789" },
    });
  });

  it("leaves fractions and exponents as numbers", () => {
    expect(parseFrame('{"a":1234567890123456.5,"b":1e30,"c":0.1700}')).toEqual({
      kind: "unknown",
      value: { a: 1234567890123456.5, b: 1e30, c: 0.17 },
    });
  });

  it("reports a frame with numbers as malformed, rather than rounding, when the runtime hides their source text", () => {
    const nativeParse = JSON.parse;
    // A runtime without JSON.parse source text access calls the reviver with two arguments only.
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
      nativeParse(
        text,
        reviver === undefined
          ? undefined
          : function (this: unknown, key: string, value: unknown) {
              return reviver.call(this, key, value);
            },
      ),
    );
    try {
      const withNumber = '{"i":700000000000000001}';
      expect(parseFrame(withNumber)).toEqual({ kind: "malformed", raw: withNumber });
      expect(parseFrame('{"a":"no numbers here"}')).toEqual({ kind: "unknown", value: { a: "no numbers here" } });
    } finally {
      spy.mockRestore();
    }
    expect(parseFrame('{"i":700000000000000001}')).toEqual({ kind: "unknown", value: { i: "700000000000000001" } });
  });
});

describe("parseFrame: acknowledgements", () => {
  it("classifies a frame with an id and a status as an ack", () => {
    expect(parseFrame('{"id":"1","status":200}')).toStrictEqual({ kind: "ack", id: "1", status: 200 });
  });

  it("keeps the result of an accepted order with its 18-digit order id intact", () => {
    const raw =
      '{"id":"2","status":200,"result":{"symbol":"DEMO-BTC15M-UP","orderId":700000000000000001,' +
      '"transactTime":1794624000000000000,"price":"0.1700","status":"NEW","type":"LIMIT","side":"BUY"}}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "ack",
      id: "2",
      status: 200,
      result: {
        symbol: "DEMO-BTC15M-UP",
        orderId: "700000000000000001",
        transactTime: "1794624000000000000",
        price: "0.1700",
        status: "NEW",
        type: "LIMIT",
        side: "BUY",
      },
    });
  });

  it("keeps the error of a rejected request", () => {
    const raw = '{"id":"9","status":400,"error":{"code":-1013,"msg":"limit price is out of range"}}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "ack",
      id: "9",
      status: 400,
      error: { code: -1013, msg: "limit price is out of range" },
    });
  });

  it("drops fields it does not model", () => {
    const raw =
      '{"id":"3","status":200,"rateLimits":[{"rateLimitType":"ORDERS","interval":"SECOND","intervalNum":10,"limit":1000,"count":1}]}';
    expect(parseFrame(raw)).toStrictEqual({ kind: "ack", id: "3", status: 200 });
  });

  it("turns a numeric id into a string", () => {
    expect(parseFrame('{"id":7,"status":200}')).toStrictEqual({ kind: "ack", id: "7", status: 200 });
    expect(parseFrame('{"id":1234567890123456789,"status":200}')).toStrictEqual({
      kind: "ack",
      id: "1234567890123456789",
      status: 200,
    });
  });

  it.each([
    ["a text result", '{"id":"4","status":200,"result":"ok"}'],
    ["an array result", '{"id":"4","status":200,"result":[1]}'],
    ["a null result", '{"id":"4","status":200,"result":null}'],
    ["a text error", '{"id":"4","status":200,"error":"bad"}'],
    ["an error with a text code", '{"id":"4","status":200,"error":{"code":"-1013","msg":"text"}}'],
    ["an error without a message", '{"id":"4","status":200,"error":{"code":-1013}}'],
    ["a null error", '{"id":"4","status":200,"error":null}'],
  ])("omits %s", (_label, raw) => {
    expect(parseFrame(raw)).toStrictEqual({ kind: "ack", id: "4", status: 200 });
  });

  it.each([
    ["no status", '{"id":"1"}'],
    ["no id", '{"status":200}'],
    ["a null id", '{"id":null,"status":200}'],
    ["an object id", '{"id":{},"status":200}'],
    ["a boolean id", '{"id":true,"status":200}'],
    ["a text status", '{"id":"1","status":"200"}'],
    ["a null status", '{"id":"1","status":null}'],
  ])("does not treat a frame with %s as an ack", (_label, raw) => {
    expect(parseFrame(raw).kind).toBe("unknown");
  });
});

// Synthetic frames in the shape the venue sends: ids and timestamps are bare JSON integers.
const CLIENT_ID = "o-00112233445566778899aabbccddeeff";
const ORDER_HEAD =
  '"e":"orderUpdate","E":1794624000000000000,"s":"DEMO-BTC15M-UP","i":700000000000000001,' +
  `"h":"hA5h0000001a","c":"${CLIENT_ID}","S":"BUY","o":"LIMIT"`;

describe("parseFrame: order updates", () => {
  it("reads a NEW event", () => {
    const raw = `{${ORDER_HEAD},"X":"NEW","p":"0.1700","q":"1.00","z":"0.00","T":1794624000000000001,"O":"YES"}`;
    expect(parseFrame(raw)).toStrictEqual({
      kind: "orderUpdate",
      orderId: "700000000000000001",
      clientOrderId: CLIENT_ID,
      symbol: "DEMO-BTC15M-UP",
      status: "NEW",
      outcome: "YES",
      quantity: "1.00",
      remaining: "0.00",
      executed: null,
      lastPrice: null,
      avgPrice: null,
      limitPrice: "0.1700",
      tradeId: null,
      fee: null,
      maker: null,
      reason: null,
    });
  });

  it("reads a FILLED event with its trade id, price, fee and maker flag", () => {
    const raw =
      `{${ORDER_HEAD},"X":"FILLED","p":"0.1700","q":"1.00","z":"0.00","Z":"1.00","L":"0.1700","a":"0.1700",` +
      '"t":5000000000000001,"n":"0.0000","m":false,"T":1794624000000000002,"O":"YES"}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "orderUpdate",
      orderId: "700000000000000001",
      clientOrderId: CLIENT_ID,
      symbol: "DEMO-BTC15M-UP",
      status: "FILLED",
      outcome: "YES",
      quantity: "1.00",
      remaining: "0.00",
      executed: "1.00",
      lastPrice: "0.1700",
      avgPrice: "0.1700",
      limitPrice: "0.1700",
      tradeId: "5000000000000001",
      fee: "0.0000",
      maker: false,
      reason: null,
    });
  });

  it("reads a CANCELED event with its reason, also when the limit price is left out", () => {
    const raw =
      `{${ORDER_HEAD},"X":"CANCELED","q":"1.00","z":"0.00","Z":"1.00","a":"0.9700",` +
      '"r":"ImmediateOrCancelWouldPost","T":1794624000000000003,"O":"NO"}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "orderUpdate",
      orderId: "700000000000000001",
      clientOrderId: CLIENT_ID,
      symbol: "DEMO-BTC15M-UP",
      status: "CANCELED",
      outcome: "NO",
      quantity: "1.00",
      remaining: "0.00",
      executed: "1.00",
      lastPrice: null,
      avgPrice: "0.9700",
      limitPrice: null,
      tradeId: null,
      fee: null,
      maker: null,
      reason: "ImmediateOrCancelWouldPost",
    });
  });

  it("upper-cases the symbol", () => {
    const frame = parseFrame('{"e":"orderUpdate","s":"demo-btc15m-up","i":700000000000000001,"X":"NEW"}');
    expect(frame).toMatchObject({ kind: "orderUpdate", symbol: "DEMO-BTC15M-UP" });
  });

  it("preserves the status verbatim, including values it does not know", () => {
    for (const status of ["PARTIALLY_FILLED", "OPEN", "MODIFIED", "REJECTED", "SOMETHING_NEW", "Filled", ""]) {
      const frame = parseFrame(`{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"${status}"}`);
      expect(frame).toMatchObject({ kind: "orderUpdate", status });
    }
  });

  it("recognises YES and NO in any case and maps any other outcome to null", () => {
    const outcomeOf = (field: string) =>
      parseFrame(`{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"NEW"${field}}`);
    expect(outcomeOf(',"O":"YES"')).toMatchObject({ outcome: "YES" });
    expect(outcomeOf(',"O":"NO"')).toMatchObject({ outcome: "NO" });
    expect(outcomeOf(',"O":"yes"')).toMatchObject({ outcome: "YES" });
    expect(outcomeOf(',"O":"No"')).toMatchObject({ outcome: "NO" });
    expect(outcomeOf(',"O":"UNSPECIFIED"')).toMatchObject({ outcome: null });
    expect(outcomeOf(',"O":1')).toMatchObject({ outcome: null });
    expect(outcomeOf("")).toMatchObject({ outcome: null });
  });

  it("gives every absent optional field as null", () => {
    expect(parseFrame('{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"NEW"}')).toStrictEqual({
      kind: "orderUpdate",
      orderId: "700000000000000001",
      clientOrderId: null,
      symbol: "DEMO-BTC15M-UP",
      status: "NEW",
      outcome: null,
      quantity: null,
      remaining: null,
      executed: null,
      lastPrice: null,
      avgPrice: null,
      limitPrice: null,
      tradeId: null,
      fee: null,
      maker: null,
      reason: null,
    });
  });

  it("treats JSON null as an absent field", () => {
    const frame = parseFrame(
      '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"CANCELED","c":null,"Z":null,"t":null,"m":null,"r":null}',
    );
    expect(frame).toMatchObject({ clientOrderId: null, executed: null, tradeId: null, maker: null, reason: null });
  });

  it("keeps empty strings as they are", () => {
    const frame = parseFrame(
      '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"CANCELED","Z":"","r":"","t":""}',
    );
    expect(frame).toMatchObject({ executed: "", reason: "", tradeId: "" });
  });

  it("turns ids that fit a Number into strings and accepts ids sent as strings", () => {
    expect(parseFrame('{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":12345,"X":"FILLED","t":678}')).toMatchObject({
      orderId: "12345",
      tradeId: "678",
    });
    expect(
      parseFrame('{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":"700000000000000001","X":"FILLED","t":"5000000000000001"}'),
    ).toMatchObject({ orderId: "700000000000000001", tradeId: "5000000000000001" });
  });

  it("turns decimals sent as JSON numbers into strings", () => {
    const frame = parseFrame(
      '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"PARTIALLY_FILLED","q":16,"z":5.00,"Z":11,"L":0.09,"n":0}',
    );
    expect(frame).toMatchObject({ quantity: "16", remaining: "5", executed: "11", lastPrice: "0.09", fee: "0" });
  });

  it.each([
    ["no order id", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","X":"NEW"}'],
    ["no symbol", '{"e":"orderUpdate","i":700000000000000001,"X":"NEW"}'],
    ["no status", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001}'],
    ["a null order id", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":null,"X":"NEW"}'],
    ["a numeric symbol", '{"e":"orderUpdate","s":42,"i":700000000000000001,"X":"NEW"}'],
    ["a numeric status", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":2}'],
    ["an order id rounded by an exponent", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":7e17,"X":"NEW"}'],
    ["an object as executed quantity", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"CANCELED","Z":{}}'],
    ["an array as executed quantity", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"CANCELED","Z":["1.00"]}'],
    ["a boolean as quantity", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"NEW","q":true}'],
    ["an overflowing number as price", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"FILLED","L":1e999}'],
    ["an object as trade id", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"FILLED","t":{"id":1}}'],
    ["an object as client order id", '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"NEW","c":{}}'],
  ])("reports an order update with %s as unknown", (_label, raw) => {
    expect(parseFrame(raw).kind).toBe("unknown");
  });

  it("maps a maker flag that is not a boolean to null", () => {
    const makerOf = (value: string) =>
      parseFrame(`{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"FILLED","m":${value}}`);
    expect(makerOf("true")).toMatchObject({ kind: "orderUpdate", maker: true });
    expect(makerOf("false")).toMatchObject({ kind: "orderUpdate", maker: false });
    expect(makerOf('"false"')).toMatchObject({ kind: "orderUpdate", maker: null });
    expect(makerOf("0")).toMatchObject({ kind: "orderUpdate", maker: null });
  });
});

describe("parseFrame: position reports", () => {
  const head = '"e":"positionReport","E":1794624000000000000,"u":1794624000000000001,"A":100200300';

  it("reads one row per instrument with its signed position", () => {
    const raw =
      `{${head},"P":[{"t":"ec","s":"DEMO-BTC15M-UP","a":[{"t":"position","v":"12"}]},` +
      '{"t":"ec","s":"DEMO-ETH15M-UP","a":[{"t":"position","v":"-3"}]}]}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "positionReport",
      rows: [
        { symbol: "DEMO-BTC15M-UP", position: "12" },
        { symbol: "DEMO-ETH15M-UP", position: "-3" },
      ],
    });
  });

  it("reads an empty snapshot", () => {
    expect(parseFrame(`{${head},"P":[]}`)).toStrictEqual({ kind: "positionReport", rows: [] });
  });

  it("upper-cases symbols", () => {
    const raw = `{${head},"P":[{"t":"ec","s":"demo-btc15m-up","a":[{"t":"position","v":"1"}]}]}`;
    expect(parseFrame(raw)).toStrictEqual({
      kind: "positionReport",
      rows: [{ symbol: "DEMO-BTC15M-UP", position: "1" }],
    });
  });

  it("keeps a row whatever entries it carries and takes the position from the position entry only", () => {
    const raw =
      `{${head},"P":[` +
      '{"t":"ec","s":"DEMO-BTC15M-UP","a":[{"t":"settlement_payout","v":"12.00","c":"usd","o":"YES"}]},' +
      '{"t":"ec","s":"DEMO-ETH15M-UP","a":[{"t":"settlement_payout","v":"1.00","c":"usd","o":"NO"},{"t":"position","v":"0"}]},' +
      '{"t":"ec","s":"DEMO-SOL15M-UP","a":[]},' +
      '{"t":"ec","s":"DEMO-XRP15M-UP"}]}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "positionReport",
      rows: [
        { symbol: "DEMO-BTC15M-UP", position: null },
        { symbol: "DEMO-ETH15M-UP", position: "0" },
        { symbol: "DEMO-SOL15M-UP", position: null },
        { symbol: "DEMO-XRP15M-UP", position: null },
      ],
    });
  });

  it("turns a numeric position into a string and maps an unusable one to null", () => {
    const raw =
      `{${head},"P":[{"s":"DEMO-BTC15M-UP","a":[{"t":"position","v":12}]},` +
      '{"s":"DEMO-ETH15M-UP","a":[{"t":"position","v":{"amount":"1"}}]},' +
      '{"s":"DEMO-SOL15M-UP","a":[{"t":"position"}]}]}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "positionReport",
      rows: [
        { symbol: "DEMO-BTC15M-UP", position: "12" },
        { symbol: "DEMO-ETH15M-UP", position: null },
        { symbol: "DEMO-SOL15M-UP", position: null },
      ],
    });
  });

  it("skips rows without a symbol", () => {
    const raw = `{${head},"P":[null,"text",7,[],{"a":[{"t":"position","v":"5"}]},{"s":42},{"s":"DEMO-BTC15M-UP","a":[{"t":"position","v":"2"}]}]}`;
    expect(parseFrame(raw)).toStrictEqual({
      kind: "positionReport",
      rows: [{ symbol: "DEMO-BTC15M-UP", position: "2" }],
    });
  });

  it.each([
    ["no row list", `{${head}}`],
    ["an object as row list", `{${head},"P":{}}`],
    ["a null row list", `{${head},"P":null}`],
  ])("reports a position report with %s as unknown", (_label, raw) => {
    expect(parseFrame(raw).kind).toBe("unknown");
  });
});

describe("parseFrame: balance updates", () => {
  const head = '"e":"balanceUpdate","E":1794624000000000000,"u":1794624000000000001';

  it("reads asset, free and current amounts", () => {
    const raw = `{${head},"B":[{"a":"USD","f":"99998.30","c":"99999.99"},{"a":"BTC","f":"1000","c":"1000"}]}`;
    expect(parseFrame(raw)).toStrictEqual({
      kind: "balanceUpdate",
      balances: [
        { asset: "USD", free: "99998.30", current: "99999.99" },
        { asset: "BTC", free: "1000", current: "1000" },
      ],
    });
  });

  it("reads an empty list", () => {
    expect(parseFrame(`{${head},"B":[]}`)).toStrictEqual({ kind: "balanceUpdate", balances: [] });
  });

  it("turns numeric amounts into strings", () => {
    expect(parseFrame(`{${head},"B":[{"a":"USD","f":100000,"c":99999.5}]}`)).toStrictEqual({
      kind: "balanceUpdate",
      balances: [{ asset: "USD", free: "100000", current: "99999.5" }],
    });
  });

  it("skips entries that lack an asset or an amount", () => {
    const raw =
      `{${head},"B":[null,"USD",{"f":"1","c":"1"},{"a":"ETH","c":"1"},{"a":"SOL","f":"1"},` +
      '{"a":"XRP","f":{},"c":"1"},{"a":7,"f":"1","c":"1"},{"a":"USD","f":"5.00","c":"6.00"}]}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "balanceUpdate",
      balances: [{ asset: "USD", free: "5.00", current: "6.00" }],
    });
  });

  it.each([
    ["no balance list", `{${head}}`],
    ["an object as balance list", `{${head},"B":{"a":"USD","f":"1","c":"1"}}`],
  ])("reports a balance update with %s as unknown", (_label, raw) => {
    expect(parseFrame(raw).kind).toBe("unknown");
  });
});

describe("parseFrame: contract status", () => {
  it("reads the transition and upper-cases the symbol", () => {
    const raw =
      '{"e":"contractStatus","E":1794624000000,"s":"demo-btc05m-up","k":"btc05m","c":"UP","i":1000001,"o":"Active","n":"Under Review"}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "contractStatus",
      symbol: "DEMO-BTC05M-UP",
      from: "Active",
      to: "Under Review",
    });
  });

  it("ignores the extra fields of a settlement transition", () => {
    const raw =
      '{"e":"contractStatus","E":1794624000000,"s":"demo-btc05m-up","k":"btc05m","c":"UP","i":1000001,"p":"97000.50","o":"Under Review","n":"Settled"}';
    expect(parseFrame(raw)).toStrictEqual({
      kind: "contractStatus",
      symbol: "DEMO-BTC05M-UP",
      from: "Under Review",
      to: "Settled",
    });
  });

  it.each([
    ["no symbol", '{"e":"contractStatus","o":"Active","n":"Settled"}'],
    ["no previous status", '{"e":"contractStatus","s":"demo-btc05m-up","n":"Settled"}'],
    ["no new status", '{"e":"contractStatus","s":"demo-btc05m-up","o":"Active"}'],
    ["a numeric status", '{"e":"contractStatus","s":"demo-btc05m-up","o":1,"n":2}'],
    ["a null status", '{"e":"contractStatus","s":"demo-btc05m-up","o":"Active","n":null}'],
  ])("reports a contract status with %s as unknown", (_label, raw) => {
    expect(parseFrame(raw).kind).toBe("unknown");
  });
});

describe("parseFrame: never throws", () => {
  const KINDS = ["ack", "orderUpdate", "positionReport", "balanceUpdate", "contractStatus", "unknown", "malformed"];

  const validFrames = [
    '{"id":"2","status":200,"result":{"symbol":"DEMO-BTC15M-UP","orderId":700000000000000001,"status":"NEW"}}',
    '{"id":"9","status":400,"error":{"code":-1013,"msg":"limit price is out of range"}}',
    `{${ORDER_HEAD},"X":"FILLED","p":"0.1700","q":"1.00","z":"0.00","Z":"1.00","L":"0.1700","a":"0.1700","t":5000000000000001,"n":"0.0000","m":false,"O":"YES"}`,
    '{"e":"positionReport","A":100200300,"P":[{"t":"ec","s":"DEMO-BTC15M-UP","a":[{"t":"position","v":"12"}]}]}',
    '{"e":"balanceUpdate","B":[{"a":"USD","f":"99998.30","c":"99999.99"}]}',
    '{"e":"contractStatus","E":1794624000000,"s":"demo-btc05m-up","o":"Active","n":"Under Review"}',
  ];

  it("classifies every sample frame as its own kind", () => {
    expect(validFrames.map((raw) => parseFrame(raw).kind)).toEqual([
      "ack",
      "ack",
      "orderUpdate",
      "positionReport",
      "balanceUpdate",
      "contractStatus",
    ]);
  });

  it("reports every truncation of a frame as malformed", () => {
    for (const raw of validFrames) {
      for (let length = 0; length < raw.length; length += 1) {
        const cut = raw.slice(0, length);
        expect(parseFrame(cut)).toEqual({ kind: "malformed", raw: cut });
      }
    }
  });

  it("returns a frame for randomly corrupted input", () => {
    const random = lcg(20261113);
    const alphabet = '{}[]":,.-+eE0123456789 \n\\ntrufalsnXZiLcq';
    for (let round = 0; round < 20_000; round += 1) {
      const base = validFrames[Math.floor(random() * validFrames.length)] ?? "";
      const chars = [...base];
      const edits = 1 + Math.floor(random() * 4);
      for (let edit = 0; edit < edits; edit += 1) {
        const position = Math.floor(random() * (chars.length + 1));
        const replacement = alphabet[Math.floor(random() * alphabet.length)] ?? "";
        const action = random();
        if (action < 0.4) chars.splice(position, 1, replacement);
        else if (action < 0.7) chars.splice(position, 0, replacement);
        else chars.splice(position, 1);
      }
      const corrupted = chars.join("");
      const frame = parseFrame(corrupted);
      expect(KINDS).toContain(frame.kind);
      if (frame.kind === "malformed") expect(frame.raw).toBe(corrupted);
    }
  });

  it.each([
    ["an event tag that is not text", '{"e":["orderUpdate"],"s":"DEMO-BTC15M-UP","i":1,"X":"NEW"}'],
    ["an event tag that is an object", '{"e":{"toString":"orderUpdate"}}'],
    ["a prototype key", '{"__proto__":{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":1,"X":"NEW"}}'],
    ["nested arrays where rows are expected", '{"e":"positionReport","P":[[[]]]}'],
    ["nested arrays where balances are expected", '{"e":"balanceUpdate","B":[[{"a":"USD","f":"1","c":"1"}]]}'],
  ])("handles %s", (_label, raw) => {
    expect(KINDS).toContain(parseFrame(raw).kind);
  });

  it("does not read fields through a prototype key", () => {
    const raw =
      '{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":700000000000000001,"X":"CANCELED","__proto__":{"c":"o-injected","Z":"9.00"}}';
    expect(parseFrame(raw)).toMatchObject({ kind: "orderUpdate", clientOrderId: null, executed: null });
    expect(parseFrame('{"__proto__":{"e":"orderUpdate","s":"DEMO-BTC15M-UP","i":1,"X":"NEW"}}').kind).toBe("unknown");
  });

  it("survives nesting deeper than the call stack", () => {
    const depth = 200_000;
    const frame = parseFrame("[".repeat(depth) + "]".repeat(depth));
    expect(["unknown", "malformed"]).toContain(frame.kind);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { e: "orderUpdate" }],
    ["an object without a prototype", Object.create(null)],
    ["a symbol", Symbol("frame")],
    ["bytes", Buffer.from('{"id":"1","status":200}')],
  ])("reports %s passed instead of text as malformed", (_label, value) => {
    expect(parseFrame(value as unknown as string)).toEqual({ kind: "malformed", raw: "" });
  });
});

/** Small deterministic generator for the randomized checks in this file. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
