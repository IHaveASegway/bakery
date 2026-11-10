// The gate, one way on the menu and the checkout (audit F1 and F3, 2026-11-10): one title, one
// sentence, Start ordering that makes a guest sandbox in place, a quieter Sign in that comes back to
// the page, and, while the new sandbox seeds, the same frame saying so with nothing to press.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  AlreadyIn,
  START_ACTION,
  START_SENTENCE,
  START_TITLE,
  StartHere,
} from '../src/components/Guest';
import { CATERING_START } from '../src/lib/catering';

const CATERING_PROPS = { title: CATERING_START.title, action: CATERING_START.action };

const html = (props: Parameters<typeof StartHere>[0]) =>
  renderToStaticMarkup(createElement(StartHere, props));

describe('StartHere', () => {
  test('says what a sandbox is in one sentence, under one title', () => {
    const out = html({ here: '/checkout/' });
    expect(out).toContain(START_TITLE);
    expect(out).toContain(START_SENTENCE.replaceAll('’', '’'));
    expect(START_SENTENCE.split('. ')).toHaveLength(1);
  });

  test('offers Start ordering, live, and a Sign in that comes back to the page', () => {
    const checkout = html({ here: '/checkout/' });
    expect(checkout).toMatch(
      /<button type="button" class="btn btn-primary">Start ordering<\/button>/,
    );
    expect(checkout).toContain('href="/signin/?next=/checkout/"');
    expect(html({ here: '/menu/' })).toContain('href="/signin/?next=/menu/"');
  });

  test('loads no challenge until Start ordering is pressed', () => {
    expect(html({ here: '/menu/' })).not.toContain('class="challenge"');
  });

  test('while the new sandbox seeds, says so and offers nothing to press twice', () => {
    const out = html({ here: '/checkout/', seeding: true });
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Setting up your sandbox…<\/button>/);
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain('>Start ordering<');
  });

  test('the menu’s banner is the same gate, with the banner’s class', () => {
    const out = html({ here: '/menu/', className: 'start-banner' });
    expect(out).toContain('class="start-here start-banner"');
    expect(out).toContain(START_TITLE);
  });
});

describe('AlreadyIn', () => {
  test('draws nothing until the API has said there is a sandbox', () => {
    expect(renderToStaticMarkup(createElement(AlreadyIn))).toBe('');
  });
});

describe('StartHere on the catering page (2026-11-10)', () => {
  test('takes its own title and button, keeps the sentence, and comes back to /catering/', () => {
    const out = html({ here: '/catering/', ...CATERING_PROPS });
    expect(out).toContain('Catering starts with your own sandbox.');
    expect(out).toMatch(/<button type="button" class="btn btn-primary">Start an inquiry<\/button>/);
    expect(out).toContain(START_SENTENCE.replaceAll('’', '’'));
    expect(out).toContain('href="/signin/?next=/catering/"');
    expect(out).not.toContain('Start ordering');
  });

  test('the menu’s and the checkout’s words are the defaults, unchanged', () => {
    expect(START_TITLE).toBe('Ordering starts with your own sandbox.');
    expect(START_ACTION).toBe('Start ordering');
  });
});
