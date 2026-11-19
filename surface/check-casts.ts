// CI: no type escape hatch anywhere in surface/ outside the sanitiser module (export/lib.ts, the one
// place a GatedText is made). Fails on `as GatedText`, `as unknown as`, or the type `any`, in code
// (comments, strings, template text and regular expression literals don't count). The run-time gate
// (checkSigned) is what holds; this keeps the compile-time brand honest too.
// Run: bun surface/check-casts.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The sanitiser module, relative to surface/.
export const SANITISER_MODULE = ["export", "lib.ts"].join(sep);
const SKIP_DIRS = new Set(["node_modules", "dist", ".expo", "web-build", ".dev"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

// The code of a source file with every comment, string, template text and regular expression
// literal blanked to spaces (line breaks kept, so line numbers hold).
export function codeOnly(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // What the last significant code was, to tell a regular expression from a division.
  let lastSig = "";
  let lastWord = "";
  const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
  // Open template literals: the brace depth at each `${`.
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  const scanTemplate = (start: number): number => {
    // From just after a ` or a }, to the closing ` (returns the index after it) or a ${ (pushes and
    // returns the index after it).
    let j = start;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") {
        blank(start, j);
        return j + 1;
      } else if (src[j] === "$" && src[j + 1] === "{") {
        blank(start, j);
        templates.push(depth);
        depth++;
        return j + 2;
      } else j++;
    }
    blank(start, n);
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastSig = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      i = scanTemplate(i + 1);
      lastSig = "`";
      lastWord = "";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        i = scanTemplate(i + 1);
        lastSig = "`";
        lastWord = "";
        continue;
      }
    }
    if (c === "/") {
      const regexStart = lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || REGEX_AFTER_WORD.has(lastWord);
      if (regexStart) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") j += 2;
          else if (inClass) {
            if (src[j] === "]") inClass = false;
            j++;
          } else if (src[j] === "[") {
            inClass = true;
            j++;
          } else if (src[j] === "/") break;
          else j++;
        }
        blank(i + 1, j);
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        lastSig = "/";
        lastWord = "";
        continue;
      }
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      lastWord = src.slice(i, j);
      lastSig = "w";
      i = j;
      continue;
    }
    lastSig = c;
    lastWord = "";
    i++;
  }
  return out.join("");
}

const RULES: [RegExp, string][] = [
  [/\bas\s+GatedText\b/, "as GatedText"],
  [/\bas\s+unknown\s+as\b/, "as unknown as"],
  [/(?<![\w$.])any(?![\w$])/, "the type any"],
];

// Each forbidden form in one file's code: "path:line: what".
export function fileProblems(path: string, src: string): string[] {
  const out: string[] = [];
  codeOnly(src)
    .split("\n")
    .forEach((line, k) => {
      for (const [re, what] of RULES) if (re.test(line)) out.push(`${path}:${k + 1}: ${what}`);
    });
  return out;
}

// Every source file under surface/, but the sanitiser module and the folders that aren't source.
export function castProblems(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
      } else if (SOURCE.test(name) && relative(root, p) !== SANITISER_MODULE) {
        out.push(...fileProblems(relative(root, p), readFileSync(p, "utf8")));
      }
    }
  };
  walk(root);
  return out;
}

if (import.meta.main) {
  const problems = castProblems(import.meta.dir);
  if (problems.length) {
    for (const p of problems) console.error(`cast check: ${p}`);
    console.error(`cast check: ${problems.length} forbidden cast(s) or any outside ${SANITISER_MODULE}`);
    process.exit(1);
  }
  console.log(`cast check: no "as GatedText", "as unknown as" or any outside ${SANITISER_MODULE}`);
}
