import { describe, expect, test } from 'vitest';
import {
  DEFAULT_NEXT,
  GUEST_NEXT,
  NEXT_PATHS,
  listedPath,
  nextFrom,
  signinFor,
} from '../src/lib/next';

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

  test('a new guest defaults to the menu, and a listed next still wins (2026-11-10)', () => {
    expect(GUEST_NEXT).toBe('/menu/');
    expect(nextFrom('', GUEST_NEXT)).toBe('/menu/');
    expect(nextFrom('?next=', GUEST_NEXT)).toBe('/menu/');
    expect(nextFrom('?next=https://example.com/', GUEST_NEXT)).toBe('/menu/');
    expect(nextFrom('?next=/checkout/', GUEST_NEXT)).toBe('/checkout/');
    expect(nextFrom('?next=/app/', GUEST_NEXT)).toBe('/app/');
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

  test('the sign-in address for a path always names it, so both defaults come back to it', () => {
    expect(signinFor('/menu/')).toBe('/signin/?next=/menu/');
    expect(signinFor('/checkout/')).toBe('/signin/?next=/checkout/');
    expect(signinFor('/app/')).toBe('/signin/?next=/app/');
    expect(signinFor(null)).toBe('/signin/');
    for (const path of Object.keys(NEXT_PATHS) as (keyof typeof NEXT_PATHS)[]) {
      const search = signinFor(path).replace('/signin/', '');
      expect(nextFrom(search)).toBe(path);
      expect(nextFrom(search, GUEST_NEXT)).toBe(path);
    }
  });

  test('a page knows its own listed path, exactly', () => {
    expect(listedPath('/catering/')).toBe('/catering/');
    expect(listedPath('/inbox/')).toBe('/inbox/');
    expect(listedPath('/checkout/')).toBe('/checkout/');
    expect(listedPath('/app/dispatch/')).toBeNull();
    expect(listedPath('/catering')).toBeNull();
    expect(listedPath('/privacy/')).toBeNull();
  });
});
