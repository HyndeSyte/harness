import { ageInWords, isOld, relative, stateLine } from "../src/time";

const now = new Date("2026-11-18T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const M = 60_000, H = 60 * M, D = 24 * H;

describe("relative times", () => {
  test.each([
    [10_000, "just now"],
    [1 * M, "1 minute ago"],
    [5 * M, "5 minutes ago"],
    [1 * H, "1 hour ago"],
    [3 * H, "3 hours ago"],
    [30 * H, "yesterday"],
    [4 * D, "4 days ago"],
    [14 * D, "14 days ago"],
    [15 * D, "over two weeks ago"],
    [22 * D, "three weeks ago"],
    [45 * D, "six weeks ago"],
    [90 * D, "three months ago"],
    [400 * D, "over a year ago"],
  ])("%d ms is %s", (ms, want) => {
    expect(relative(ago(ms), now)).toBe(want);
  });

  test("older than 14 days is old, and its age is in words", () => {
    expect(isOld(ago(14 * D), now)).toBe(false);
    expect(isOld(ago(15 * D), now)).toBe(true);
    expect(ageInWords(29 * D)).toBe("four weeks");
    expect(relative(ago(29 * D), now)).not.toMatch(/\d/);
  });
});

describe("the state line", () => {
  test("fresh", () => {
    expect(stateLine("2026-11-18T09:14:00Z", now)).toBe("As of 9:14 AM");
  });
  test("stale after six hours", () => {
    expect(stateLine("2026-11-18T05:00:00Z", now)).toBe("as of 5:00 AM, 7 hours old");
  });
  test("in the future is labelled, never a negative age", () => {
    expect(stateLine("2026-11-18T14:00:00Z", now)).toBe("As of 2:00 PM, dated ahead of this device's clock");
    expect(stateLine("2026-11-18T12:00:30Z", now)).toBe("As of 12:00 PM");
    expect(relative("2026-11-18T13:00:00Z", now)).toBe("ahead of this device's clock");
  });
  test("another day names the day", () => {
    expect(stateLine("2026-11-17T23:00:00Z", now)).toBe("as of Tue, Nov 17, 11:00 PM, 13 hours old");
  });
});
