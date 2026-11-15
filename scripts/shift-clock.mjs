// Moves the wall clock forward by SHIFT_DAYS for whatever Node process loads it:
//
//   SHIFT_DAYS=400 NODE_OPTIONS="--import $PWD/scripts/shift-clock.mjs" pnpm -r test
//
// A unit test must not depend on today's date. CI runs the tests a second time through this
// file, so a test that only passes today fails there instead of some days later.
const shiftMs = Number(process.env.SHIFT_DAYS ?? "0") * 86_400_000;

if (Number.isFinite(shiftMs) && shiftMs !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(realNow() + shiftMs);
      else super(...args);
    }

    static now() {
      return realNow() + shiftMs;
    }
  };
}
