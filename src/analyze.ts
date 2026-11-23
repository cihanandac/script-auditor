/**
 * Prepares a new or changed script for review: readable code, a diff against the previous
 * version, risk indicators and the hosts the code talks to. Everything an LLM needs to judge
 * the change, cut down to a size budget with the riskiest parts first.
 */
import { structuredPatch, type StructuredPatchHunk } from 'diff';
import { format } from 'prettier';

export interface IndicatorPattern {
  name: string;
  label: string;
  pattern: RegExp;
}

/** Things skimmers, loaders and miners need. A change in their count is worth a look. */
export const INDICATORS: IndicatorPattern[] = [
  {
    name: 'dynamic-code',
    label: 'eval / new Function / string timers',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
  },
  {
    name: 'encoding',
    label: 'atob / btoa / fromCharCode / unescape',
    pattern: /\b(?:atob|btoa)\s*\(|String\.fromCharCode|\bunescape\s*\(/g,
  },
  { name: 'cookies', label: 'document.cookie', pattern: /document\.cookie/g },
  {
    name: 'storage',
    label: 'localStorage / sessionStorage / indexedDB',
    pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/g,
  },
  {
    name: 'network',
    label: 'fetch / XHR / sendBeacon / WebSocket',
    pattern:
      /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\s*\(|\bnew\s+WebSocket\s*\(|\bEventSource\b/g,
  },
  {
    name: 'script-injection',
    label: 'injects scripts or HTML',
    pattern:
      /createElement\s*\(\s*["'`](?:script|iframe)["'`]|document\.write(?:ln)?\s*\(|insertAdjacentHTML|\.innerHTML\s*=|\.outerHTML\s*=/gi,
  },
  {
    name: 'form-access',
    label: 'reads forms, inputs or keystrokes',
    pattern:
      /addEventListener\s*\(\s*["'`](?:submit|input|change|keydown|keyup|keypress|paste|blur)["'`]|type\s*=\s*\\?["']?password|querySelectorAll?\s*\(\s*["'`][^"'`]*\b(?:input|form|select|textarea)\b/gi,
  },
  {
    name: 'payment-data',
    label: 'card / CVV / IBAN fields',
    pattern: /\b(?:card[_-]?(?:number|holder)|cc[_-]?(?:num|number)|cvv|cvc|iban|expiry)\b/gi,
  },
  {
    name: 'redirect',
    label: 'changes location',
    pattern:
      /\b(?:window|document|top|self)\.location(?:\.href)?\s*=[^=]|location\.(?:replace|assign)\s*\(/g,
  },
  {
    name: 'crypto-mining',
    label: 'WebAssembly / mining',
    pattern: /WebAssembly\.(?:instantiate|compile)|coinhive|cryptonight|stratum\+tcp/gi,
  },
  {
    name: 'obfuscation',
    label: '_0x names, hex escapes, long encoded strings',
    pattern: /\b_0x[0-9a-f]{4,}\b|(?:\\x[0-9a-f]{2}){8,}|["'`][A-Za-z0-9+/]{300,}={0,2}["'`]/gi,
  },
];

export interface IndicatorDelta {
  name: string;
  label: string;
  old: number;
  new: number;
}

export interface Analysis {
  kind: 'new' | 'changed';
  oldSize?: number;
  newSize: number;
  /** Indicators present in the new version or whose count changed. */
  indicators: IndicatorDelta[];
  /** Hosts the new version references that the old one did not (all hosts for new scripts). */
  addedHosts: string[];
  removedHosts: string[];
  /** Only numbers and id-like tokens differ, and no host was added: nothing to review. */
  literalOnly: boolean;
  /** Excerpt for the reviewer: a unified diff, or the code of a new script. */
  excerpt: string;
  /** What the excerpt leaves out, in words; empty if it is complete. */
  omitted: string;
}

export async function analyze(
  newBody: Uint8Array,
  oldBody: Uint8Array | undefined,
  maxChars: number,
): Promise<Analysis> {
  const newCode = Buffer.from(newBody).toString('utf8');
  const oldCode = oldBody ? Buffer.from(oldBody).toString('utf8') : undefined;
  const newHosts = hostsInCode(newCode);
  const oldHosts = oldCode === undefined ? new Set<string>() : hostsInCode(oldCode);
  const addedHosts = [...newHosts].filter((host) => !oldHosts.has(host)).sort();
  const removedHosts = [...oldHosts].filter((host) => !newHosts.has(host)).sort();
  const newCounts = countIndicators(newCode);
  const oldCounts = oldCode === undefined ? undefined : countIndicators(oldCode);
  const indicators = INDICATORS.map(({ name, label }) => ({
    name,
    label,
    old: oldCounts?.[name] ?? 0,
    new: newCounts[name] ?? 0,
  })).filter((delta) => delta.new > 0 || delta.old !== delta.new);

  const base = {
    newSize: newBody.length,
    indicators,
    addedHosts,
    removedHosts,
  };

  if (oldCode === undefined) {
    const pretty = await beautify(newCode);
    const { text, omitted } = excerptOfCode(pretty, maxChars);
    return { ...base, kind: 'new', literalOnly: false, excerpt: text, omitted };
  }

  const literalOnly = isLiteralOnlyChange(oldCode, newCode);
  const [oldPretty, newPretty] = await Promise.all([beautify(oldCode), beautify(newCode)]);
  const patch = structuredPatch('old.js', 'new.js', oldPretty, newPretty, '', '', {
    context: 3,
    timeout: 10_000,
  });
  const common = { ...base, kind: 'changed' as const, oldSize: oldBody?.length, literalOnly };
  if (!patch) {
    // Too different to diff in time, e.g. a rebuilt bundle: show the new code instead
    const { text, omitted } = excerptOfCode(newPretty, maxChars);
    return {
      ...common,
      excerpt: text,
      omitted: `The versions are too different to diff; this is the new code. ${omitted}`.trim(),
    };
  }
  const { text, omitted } = excerptOfHunks(patch.hunks, addedHosts, maxChars);
  return { ...common, excerpt: text, omitted };
}

export function countIndicators(code: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { name, pattern } of INDICATORS) {
    counts[name] = code.match(pattern)?.length ?? 0;
  }
  return counts;
}

/** Host names in absolute and protocol-relative URLs of the code. */
export function hostsInCode(code: string): Set<string> {
  const hosts = new Set<string>();
  for (const match of code.matchAll(
    /(?:https?:|wss?:)?\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?=[/:?#"'`\\\s)]|$)/gi,
  )) {
    const host = match[1]!.toLowerCase();
    // Skip things like "//www.w3.org" in SVG namespaces, they are not requests
    if (/(?:^|\.)w3\.org$/.test(host)) {
      continue;
    }
    // A name ending in a letter label, or an IPv4 address: an exfiltration endpoint that
    // only changes digits must not pass as a literal-only change
    if (/[a-z]/.test(host.split('.').pop()!) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      hosts.add(host);
    }
  }
  return hosts;
}

/** Only numbers and long id-like tokens differ, and the new code references no new host. */
export function isLiteralOnlyChange(oldCode: string, newCode: string): boolean {
  if (normalizeLiterals(oldCode) !== normalizeLiterals(newCode)) {
    return false;
  }
  const oldHosts = hostsInCode(oldCode);
  return [...hostsInCode(newCode)].every((host) => oldHosts.has(host));
}

/**
 * Replaces numbers, hex hashes and long id-like tokens, the parts that change on every
 * request or deployment (timestamps, cache keys, request ids, build and commit hashes).
 */
export function normalizeLiterals(code: string): string {
  return code
    .replace(/\b[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g, (token) => (token.length >= 16 ? 'ID' : token))
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, 'HEX')
    .replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, '0');
}

export async function beautify(code: string): Promise<string> {
  try {
    return await format(code, { parser: 'babel', printWidth: 120 });
  } catch {
    // Not parseable as JavaScript (or a syntax prettier does not know): line breaks at
    // statement and block boundaries still give the diff something to work with
    return code.replace(/([;{}])(?=\S)/g, '$1\n');
  }
}

function excerptOfCode(code: string, maxChars: number): { text: string; omitted: string } {
  if (code.length <= maxChars) {
    return { text: code, omitted: '' };
  }
  // A window around every risky spot and URL, scored by how many risky spots it covers.
  // Windows are picked by score, not merged first: in dense code merging would produce one
  // range larger than the whole budget.
  const radius = 600;
  const spots: { index: number; weight: number }[] = [];
  for (const { pattern } of INDICATORS) {
    for (const match of code.matchAll(pattern)) {
      spots.push({ index: match.index, weight: 3 });
    }
  }
  for (const match of code.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    spots.push({ index: match.index, weight: 2 });
  }
  spots.sort((a, b) => a.index - b.index);
  // Sliding window over the sorted spots: the weight of all spots within each window
  let low = 0;
  let high = 0;
  let weight = 0;
  const windows = spots.map(({ index }) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(code.length, index + radius);
    while (high < spots.length && spots[high]!.index < end) {
      weight += spots[high++]!.weight;
    }
    while (spots[low]!.index < start) {
      weight -= spots[low++]!.weight;
    }
    return { start, end, score: weight };
  });
  windows.sort((a, b) => b.score - a.score || a.start - b.start);

  // The start of the file first, then the best windows until the budget is spent
  const chosen: [number, number][] = [[0, Math.floor(maxChars * 0.25)]];
  let used = chosen[0]![1];
  for (const window of windows) {
    if (used >= maxChars) {
      break;
    }
    // Only the part not shown yet, cut to the remaining budget
    let { start, end } = window;
    for (const [shownStart, shownEnd] of chosen) {
      if (start < shownEnd && end > shownStart) {
        if (start >= shownStart) {
          start = Math.max(start, shownEnd);
        } else {
          end = Math.min(end, shownStart);
        }
      }
    }
    end = Math.min(end, start + (maxChars - used));
    if (end - start < 100) {
      continue;
    }
    chosen.push([start, end]);
    used += end - start;
  }

  const parts = mergeRanges(chosen).map(([start, end]) => {
    const piece = code.slice(start, end);
    return start === 0 ? piece : `/* ... offset ${start} ... */\n${piece}`;
  });
  const shown = mergeRanges(chosen).reduce((sum, [start, end]) => sum + end - start, 0);
  const percent = Math.round((shown / code.length) * 100);
  return {
    text: parts.join('\n'),
    omitted: `Only ${percent}% of the ${code.length} characters are shown: the start of the file and the code around risk indicators and URLs.`,
  };
}

function excerptOfHunks(
  hunks: StructuredPatchHunk[],
  addedHosts: string[],
  maxChars: number,
): { text: string; omitted: string } {
  const scored = segmentsOf(hunks).map((segment, index) => {
    const added = segment.lines.filter((line) => line.startsWith('+')).join('\n');
    let score = 0;
    for (const host of addedHosts) {
      if (added.includes(host)) {
        score += 10;
      }
    }
    for (const { pattern } of INDICATORS) {
      score += (added.match(pattern)?.length ?? 0) * 3;
    }
    return { index, score, text: `${segment.header}\n${segment.lines.join('\n')}` };
  });
  const chosen: typeof scored = [];
  let used = 0;
  let truncated = false;
  for (const hunk of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const remaining = maxChars - used;
    if (hunk.text.length > remaining) {
      // A segment of long lines can exceed the whole budget: show its start rather than
      // nothing, at least for the riskiest one
      if (chosen.length > 0 || remaining < 500) {
        continue;
      }
      const marker = '\n/* ... rest of this segment left out for size ... */';
      chosen.push({ ...hunk, text: hunk.text.slice(0, remaining - marker.length) + marker });
      used = maxChars;
      truncated = true;
      continue;
    }
    chosen.push(hunk);
    used += hunk.text.length;
  }
  chosen.sort((a, b) => a.index - b.index);
  const text = chosen.map((hunk) => hunk.text).join('\n');
  const omitted =
    chosen.length === scored.length && !truncated
      ? ''
      : `${scored.length - chosen.length} of ${scored.length} diff hunks are left out for size${truncated ? ', and the riskiest one is cut short' : ''}; the riskiest ones are shown.`;
  return { text, omitted };
}

const SEGMENT_LINES = 60;

/**
 * Splits long hunks (a rebuilt bundle is often one hunk) into segments of a few dozen
 * lines, so the budget can be spent on the risky parts.
 */
function segmentsOf(hunks: StructuredPatchHunk[]): { header: string; lines: string[] }[] {
  const segments: { header: string; lines: string[] }[] = [];
  for (const hunk of hunks) {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const lines = compactLongLines(hunk.lines);
    if (lines.length <= SEGMENT_LINES) {
      segments.push({ header, lines });
      continue;
    }
    for (let start = 0; start < lines.length; start += SEGMENT_LINES) {
      segments.push({
        header: `${header} lines ${start + 1}-${Math.min(start + SEGMENT_LINES, lines.length)} of this hunk`,
        lines: lines.slice(start, start + SEGMENT_LINES),
      });
    }
  }
  return segments;
}

const LONG_LINE = 1500;
const LINE_CONTEXT = 200;

/**
 * Formatting cannot break up long strings, such as a JSON config embedded in one line. When
 * such a line changed, only the part that differs from its old version is kept, with some
 * context; other long lines are cut.
 */
export function compactLongLines(lines: string[]): string[] {
  const result = [...lines];
  // Pair each run of removed lines with the run of added lines that follows it
  for (let index = 0; index < result.length;) {
    let removedEnd = index;
    while (removedEnd < result.length && result[removedEnd]!.startsWith('-')) {
      removedEnd++;
    }
    let addedEnd = removedEnd;
    while (addedEnd < result.length && result[addedEnd]!.startsWith('+')) {
      addedEnd++;
    }
    const pairs = Math.min(removedEnd - index, addedEnd - removedEnd);
    for (let pair = 0; pair < pairs; pair++) {
      const oldIndex = index + pair;
      const newIndex = removedEnd + pair;
      const [oldLine, newLine] = [result[oldIndex]!, result[newIndex]!];
      if (oldLine.length > LONG_LINE || newLine.length > LONG_LINE) {
        [result[oldIndex], result[newIndex]] = differingParts(oldLine, newLine);
      }
    }
    index = addedEnd > index ? addedEnd : index + 1;
  }
  return result.map((line) =>
    line.length > LONG_LINE * 2
      ? `${line.slice(0, LONG_LINE)} /* ...${line.length - LONG_LINE} more characters... */`
      : line,
  );
}

function differingParts(oldLine: string, newLine: string): [string, string] {
  // Skip the +/- marker, then find the common prefix and suffix of both lines
  let prefix = 1;
  while (
    prefix < oldLine.length &&
    prefix < newLine.length &&
    oldLine[prefix] === newLine[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLine.length - prefix &&
    suffix < newLine.length - prefix &&
    oldLine[oldLine.length - 1 - suffix] === newLine[newLine.length - 1 - suffix]
  ) {
    suffix++;
  }
  const cut = (line: string) => {
    const start = Math.max(1, prefix - LINE_CONTEXT);
    const end = Math.min(line.length, line.length - suffix + LINE_CONTEXT);
    let middle = line.slice(start, end);
    if (middle.length > LONG_LINE * 2) {
      middle = `${middle.slice(0, LONG_LINE)} /* ...${middle.length - LONG_LINE * 2} characters... */ ${middle.slice(-LONG_LINE)}`;
    }
    const before = start > 1 ? `/* ...${start - 1} characters... */ ` : '';
    const after = end < line.length ? ` /* ...${line.length - end} characters... */` : '';
    return `${line[0]}${before}${middle}${after}`;
  };
  return [cut(oldLine), cut(newLine)];
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}
