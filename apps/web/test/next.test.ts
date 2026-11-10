import { describe, expect, test } from 'vitest';
import { DEFAULT_NEXT, NEXT_PATHS, nextFrom, signinFor } from '../src/lib/next';

describe('the sign-in page’s next parameter (decision G2)', () => {
  test.each(Object.keys(NEXT_PATHS))('takes %s, written exactly', (path) => {
    expect(nextFrom(`?next=${path}`)).toBe(path);
    expect(nextFrom(`?error=denied&next=${path}`)).toBe(path);
    // An escaped spelling of a listed path is not the exact string, so it is refused too.
    expect(nextFrom(`?next=${encodeURIComponent(path)}`)).toBe('/app/');
  });

  test('defaults to the console with no next, or an empty one', () => {
    expect(DEFAULT_NEXT).toBe('/app/');
    expect(nextFrom('')).toBe('/app/');
    expect(nextFrom('?next=')).toBe('/app/');
    expect(nextFrom('?error=denied')).toBe('/app/');
  });

  test.each([
    'https://example.com/menu/',
    'http://example.com/menu/',
    '//example.com/menu/',
    '///example.com/',
    '/\\example.com/',
    '\\\\example.com/menu/',
    '/menu%2F',
    '%2Fmenu%2F',
    '%2F%2Fexample.com',
    '/menu',
    '/menu/?x=1',
    '/menu/#cart',
    '/MENU/',
    ' /menu/',
    '/app/../evil/',
    'javascript:alert(1)',
    '/privacy/',
  ])('refuses %s: no open redirect, and only the listed paths', (value) => {
    expect(nextFrom(`?next=${value}`)).toBe('/app/');
  });

  test('refuses an encoded slash however it is escaped', () => {
    expect(nextFrom('?next=%2F%2Fexample.com%2F')).toBe('/app/');
    expect(nextFrom('?next=%252Fmenu%252F')).toBe('/app/');
  });

  test('a repeated next takes the first only', () => {
    expect(nextFrom('?next=https://example.com/&next=/menu/')).toBe('/app/');
    expect(nextFrom('?next=/menu/&next=https://example.com/')).toBe('/menu/');
  });

  test('the sign-in address for a path names it, and the console needs no parameter', () => {
    expect(signinFor('/menu/')).toBe('/signin/?next=/menu/');
    expect(signinFor('/app/')).toBe('/signin/');
    for (const path of Object.keys(NEXT_PATHS) as (keyof typeof NEXT_PATHS)[]) {
      expect(nextFrom(signinFor(path).replace('/signin/', ''))).toBe(path);
    }
  });
});
