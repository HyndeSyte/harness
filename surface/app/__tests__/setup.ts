// Test environment only: jsdom has no TextEncoder, though every runtime the app ships to does
// (browsers, Hermes). Node's standard encoder stands in, so the shared canonical form runs
// unchanged under test.
import { TextDecoder, TextEncoder } from "util";

const g = globalThis as Record<string, unknown>;
if (typeof g.TextEncoder === "undefined") g.TextEncoder = TextEncoder;
if (typeof g.TextDecoder === "undefined") g.TextDecoder = TextDecoder;
