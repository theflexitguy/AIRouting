import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LIMIT, MAX_RESPONSE_CHARS, fail, fmtMinutes, money, ok, paginate, pct, round } from "./format.ts";

describe("ok / fail", () => {
  it("returns the payload once, as text (no structuredContent duplicate)", () => {
    const r = ok({ a: 1, list: [1, 2] });
    assert.equal(r.isError, undefined);
    assert.equal(r.content.length, 1);
    assert.deepEqual(JSON.parse((r.content[0] as { text: string }).text), { a: 1, list: [1, 2] });
    assert.equal("structuredContent" in r, false, "the same data must not be sent twice");
  });

  it("emits compact JSON (no pretty-printing whitespace)", () => {
    assert.equal((ok({ a: 1 }).content[0] as { text: string }).text, '{"a":1}');
  });

  it("refuses an oversize result with advice, instead of flooding the client", () => {
    const r = ok({ blob: "x".repeat(MAX_RESPONSE_CHARS + 1) });
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /too large.*Narrow the filters.*offset/s);
  });

  it("fail() marks an error", () => {
    const r = fail("nope");
    assert.equal(r.isError, true);
    assert.equal((r.content[0] as { text: string }).text, "nope");
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);
  it("returns a page with continuation info", () => {
    const p = paginate(rows, 4, 0);
    assert.deepEqual(p, { items: [0, 1, 2, 3], total: 10, offset: 0, limit: 4, hasMore: true, nextOffset: 4 });
  });
  it("ends cleanly on the last page", () => {
    const p = paginate(rows, 4, 8);
    assert.deepEqual(p.items, [8, 9]);
    assert.equal(p.hasMore, false);
    assert.equal(p.nextOffset, null);
  });
  it("handles an offset past the end and an empty list", () => {
    assert.deepEqual(paginate(rows, 4, 99).items, []);
    assert.equal(paginate(rows, 4, 99).hasMore, false);
    assert.deepEqual(paginate([], 4, 0), { items: [], total: 0, offset: 0, limit: 4, hasMore: false, nextOffset: null });
  });
  it("clamps limit and offset to sane values", () => {
    assert.equal(paginate(rows, 10_000, 0).limit, MAX_LIMIT);
    assert.equal(paginate(rows, 0, 0).limit, 50); // 0 → default
    assert.equal(paginate(rows, -5, -5).offset, 0);
    assert.equal(paginate(rows, 2.9, 0).limit, 2);
  });
  it("visits every row exactly once when following nextOffset", () => {
    const seen: number[] = [];
    let off: number | null = 0;
    while (off !== null) {
      const p: ReturnType<typeof paginate<number>> = paginate(rows, 3, off);
      seen.push(...p.items);
      off = p.nextOffset;
    }
    assert.deepEqual(seen, rows);
  });
});

describe("number helpers", () => {
  it("round() handles nulls, non-finite values and digits", () => {
    assert.equal(round(1.2345, 2), 1.23);
    assert.equal(round(1.25, 1), 1.3);
    assert.equal(round(null), null);
    assert.equal(round(undefined), null);
    assert.equal(round(Number.NaN), null);
    assert.equal(round(Infinity), null);
    assert.equal(round(4), 4);
  });
  it("pct() matches the dashboard's Math.round(x*100)", () => {
    assert.equal(pct(0.6), 60);
    assert.equal(pct(0.005), 1);
    assert.equal(pct(1.834), 183);
  });
  it("fmtMinutes() matches the drive-time cards", () => {
    assert.equal(fmtMinutes(80), "1h 20m");
    assert.equal(fmtMinutes(45), "45m");
    assert.equal(fmtMinutes(60), "1h 0m");
    assert.equal(fmtMinutes(0), "0m");
  });
  it("money() formats whole US dollars", () => {
    assert.equal(money(1234.4), "$1,234");
  });
});
