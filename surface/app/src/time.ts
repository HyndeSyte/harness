// Times in words, for the state line and each row.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const STALE_AFTER = 6 * HOUR;
export const OLD_AFTER = 14 * DAY;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const word = (n: number) => WORDS[n] ?? String(n);
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

// "moved <this>". Up to 14 days in figures; older, its age in words.
export function relative(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute") + " ago";
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour") + " ago";
  if (ms < 2 * DAY) return "yesterday";
  if (ms <= OLD_AFTER) return `${Math.floor(ms / DAY)} days ago`;
  return ageInWords(ms) + " ago";
}

export function ageInWords(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days < 21) return "over two weeks";
  if (days < 60) return `${word(Math.floor(days / 7))} weeks`;
  if (days < 365) return `${word(Math.floor(days / 30))} months`;
  const years = Math.floor(days / 365);
  return years === 1 ? "over a year" : `${word(years)} years`;
}

export function isOld(iso: string, now: Date): boolean {
  return now.getTime() - Date.parse(iso) > OLD_AFTER;
}

function clock(d: Date, now: Date): string {
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

// The one line at the top.
export function stateLine(madeAt: string, now: Date): string {
  const made = new Date(madeAt);
  const age = now.getTime() - made.getTime();
  if (age > STALE_AFTER) return `as of ${clock(made, now)}, ${plural(Math.floor(age / HOUR), "hour")} old`;
  return `As of ${clock(made, now)}`;
}
