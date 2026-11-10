// What the console asks before it deletes something, in the page, never with the browser's own
// `window.confirm` or `alert`: a dialog of the browser's cannot be styled, read by the guide or
// tested as the page is, and on a phone it covers the page it is about. The pattern is the one the
// top bar's Leave has had since 2026-11-09: what will go, then the action and the way back, with
// the focus on the way back and Escape taking it (components/ConfirmStep.tsx).

/** One question: its title, what it deletes, and the two buttons' words. */
export interface Confirmation {
  title: string;
  lines: string[];
  confirm: string;
  cancel: string;
}

export type Asked = 'wipe' | 'replace' | 'rotate';

/** The question for `asked`, naming the sandbox by its short code where it has one. */
export function confirmation(asked: Asked, short: string | null = null): Confirmation {
  const sandbox = short === null ? 'This sandbox' : `Sandbox ${short}`;
  switch (asked) {
    case 'wipe':
      return {
        title: 'Wipe this sandbox now?',
        lines: [
          `${sandbox} is deleted for good, with its orders, customers, messages and events.`,
          'Nothing brings it back. You can start a new one afterwards.',
        ],
        confirm: 'Wipe it',
        cancel: 'Keep it',
      };
    case 'replace':
      return {
        title: 'Replace this sandbox?',
        lines: [
          `${sandbox} is deleted now, with its orders, customers, messages and events.`,
          'A new one, seeded fresh, takes its place until the next wipe at 10:00 UTC.',
        ],
        confirm: 'Replace it',
        cancel: 'Keep this one',
      };
    case 'rotate':
      return {
        title: 'Rotate the token?',
        lines: [
          'The token you have now stops working at once, in every script that uses it.',
          'The new one is shown here once.',
        ],
        confirm: 'Rotate it',
        cancel: 'Keep it',
      };
  }
}

/** The line after a replace: the new sandbox's code, the old one gone. */
export const replacedText = (old: string, now: string): string =>
  `Sandbox ${now} is yours now. Sandbox ${old} and everything in it are deleted.`;
