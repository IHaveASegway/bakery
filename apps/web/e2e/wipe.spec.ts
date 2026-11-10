// The wipe (ADR 0005): a visitor's "Wipe now", and the nightly wipe run through the API's
// scheduled handler as the 10:00 UTC cron runs it, after which the local half of the morning
// object check (scripts/list-objects.mjs) finds no sandbox-scoped object holding data. The
// nightly wipe takes every sandbox of the day, so this file runs last (the config's one worker
// runs the files in name order).
import {
  API,
  API_DIRECT,
  demoAccount,
  expect,
  listObjects,
  liveSandbox,
  runCron,
  test,
} from './fixtures';

// After a wipe the console asks for its sandbox and the API answers 410, which Chromium logs.
test.use({ allowedStatuses: [410] });

test('Wipe now deletes the sandbox at once', async ({ page }) => {
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  // Wipe now is in the top bar's sandbox menu, on every console page.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /^Sandbox / }).click();
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

// The race of 2026-11-08: the Kitchen closes the board's socket with "wiped" partway through the
// wipe, and the browser reports the close about 2 s later, so on a slow machine it comes before
// the wipe's answer. A console that reloaded then asked for its session with the old cookie and
// for the sandbox with the one the answer re-issued, which names no sandbox, and got the 404 of
// an id that is not the session's (docs/security.md, "The wipe"). Here the wipe's answer is held
// until the close, and let through as soon as the console asks for its session or its sandbox, or
// beats for the board, or a second after the close if it does none of these. It must do none: the
// wipe's own answer decides what the console shows. The screens' own timed looks are not counted:
// while the answer is held they carry the old cookie.
test('Wipe now asks nothing more when the socket closes before the wipe answers', async ({
  page,
  clientIp,
}) => {
  await demoAccount(page);
  const { id } = await liveSandbox(page);

  // Listening before the page loads, so the board's socket is seen when it opens.
  let closed = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('close', () => {
      closed = true;
      setTimeout(release, 1_000);
    });
  });
  const watched = ['/v1/session', `/v1/sandboxes/${id}`, `/v1/sandboxes/${id}/heartbeat`];
  page.on('request', (r) => {
    if (!closed || !r.url().startsWith(`${API}/`)) return;
    const path = new URL(r.url()).pathname;
    if (!watched.includes(path)) return;
    asked.push(`${r.method()} ${path}`);
    release();
  });
  // The wipe goes to the API as the browser sent it, with its cookie, and its answer (and the
  // cookie that answer re-issues) waits for the close.
  await page.route(`${API}/v1/sandboxes/${id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const jar = await page.context().cookies(API);
    const answer = await route.fetch({
      url: `${API_DIRECT}/v1/sandboxes/${id}`,
      headers: {
        ...(await route.request().allHeaders()),
        cookie: jar.map((c) => `${c.name}=${c.value}`).join('; '),
        'cf-connecting-ip': clientIp,
      },
    });
    expect(answer.status()).toBe(200);
    await released;
    await route.fulfill({ response: answer });
  });

  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();
  // Wipe now is in the top bar's sandbox menu, on every console page.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /^Sandbox / }).click();
  await page.getByRole('button', { name: 'Wipe now' }).click();
  await expect(
    page
      .getByRole('heading', { name: 'Your sandbox is wiped' })
      .or(page.getByRole('heading', { name: 'You have no sandbox' })),
  ).toBeVisible();
  expect(closed, 'the Kitchen closed the board before the wipe answered').toBe(true);
  expect(asked, 'what the console asked after the close').toEqual([]);
  await expect(page.getByRole('heading', { name: 'Your sandbox is wiped' })).toBeVisible();
  // The button that had the focus went with the sandbox: the wiped view's heading has it (audit N7).
  await expect(page.locator('#gone-heading')).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You have no sandbox' })).toBeVisible();
});

test('the nightly wipe deletes every sandbox and leaves no object holding data', async ({
  page,
}) => {
  // The wipe goes through every sandbox this run has made, and this one is the newest, so the wait
  // grows with the suite: alone the test takes about 6 s; after 103 tests it took 30 s in CI on
  // 2026-11-10, and after 127 the old 30 s wait ran out. Two minutes is room for a suite several
  // times this size; the test's own limit is raised to hold that wait and the listing after it.
  test.setTimeout(4 * 60_000);
  await demoAccount(page);
  await liveSandbox(page);
  await page.goto('/app/');
  await expect(page.getByText('Live. Changes appear here as they happen.')).toBeVisible();

  expect(await runCron('0 10 * * *')).toBe(200);
  // The Kitchen closes the board's socket with "wiped", and the console asks again.
  await expect(page.getByRole('heading', { name: /Your sandbox was deleted/ })).toBeVisible({
    timeout: 120_000,
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
