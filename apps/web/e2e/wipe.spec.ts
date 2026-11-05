// The wipe (ADR 0005): a visitor's "Wipe now", and the nightly wipe run through the API's
// scheduled handler as the 10:00 UTC cron runs it, after which the local half of the morning
// object check (scripts/list-objects.mjs) finds no sandbox-scoped object holding data. The
// nightly wipe takes every sandbox of the day, so this file runs last (the config's one worker
// runs the files in name order).
import { demoAccount, expect, listObjects, liveSandbox, runCron, test } from './fixtures';

// After a wipe the console asks for its sandbox and the API answers 410, which Chromium logs.
test.use({ allowedStatuses: [410] });

test('Wipe now deletes the sandbox at once', async ({ page }) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Wipe now' }).click();
  // Two answers race, both right: the button's own "wiped", or the console reloading first
  // because the Kitchen closed the board's socket with "wiped" and the session names no sandbox.
  await expect(
    page
      .getByRole('heading', { name: 'Your sandbox is wiped' })
      .or(page.getByRole('heading', { name: 'You have no sandbox' })),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your sandbox', exact: true })).toHaveCount(0);
  // The session no longer names a sandbox: a reload finds none.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toBeVisible();
});

test('the nightly wipe deletes every sandbox and leaves no object holding data', async ({
  page,
}) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  expect(await runCron('0 10 * * *')).toBe(200);
  // The Kitchen closes the board's socket with "wiped", and the console asks again.
  await expect(page.getByRole('heading', { name: /Your sandbox was deleted/ })).toBeVisible({
    timeout: 30_000,
  });

  await expect
    .poll(() => listObjects().exit, { timeout: 30_000, message: 'list-objects.mjs exits 0' })
    .toBe(0);
  const { objects } = listObjects();
  // Control and Account outlive every sandbox on purpose; the listing saw them, so it read state.
  expect(objects.some((o) => o.class === 'Control')).toBe(true);
  expect(objects.filter((o) => o.has_data && !['Control', 'Account'].includes(o.class))).toEqual(
    [],
  );
});
