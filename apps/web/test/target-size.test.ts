// Targets of 24 CSS pixels at least (WCAG 2.2, 2.5.8): the checkout's radio inputs and the API
// reference's links that stand on a line of their own (audit P10, P11). Measured in a browser on
// 2026-11-08; this keeps the rules that produce those sizes.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('target size', () => {
  test('radio inputs are 1.5rem square', () => {
    const rule = block("input[type='radio']");
    expect(rule).toContain('width: 1.5rem');
    expect(rule).toContain('height: 1.5rem');
  });

  test('block-level API reference links are at least 1.5rem tall', () => {
    const start = css.indexOf('.api-index a,\n.api-op');
    const rule = css.slice(start, css.indexOf('}', start));
    for (const selector of ['.api-op li > a', '.api-op h5 > a', '.table-scroll td > a']) {
      expect(rule).toContain(selector);
    }
    expect(rule).toContain('display: inline-block');
    expect(rule).toContain('min-height: 1.5rem');
  });
});
