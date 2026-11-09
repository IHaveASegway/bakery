// One visitor's cookie against another visitor's sandbox: the answer is a 404 problem document, the
// same as for a sandbox that does not exist, so a sandbox's id is never confirmed to a stranger.
import { api, demoAccount, expect, liveSandbox, test, API } from './fixtures';

// The 404 is the answer under test, and Chromium logs it.
test.use({ allowedStatuses: [404] });

test("a sandbox's cookie gets a 404 for another sandbox's resources", async ({
  page,
  clientIp,
}) => {
  await demoAccount(page);
  const first = await liveSandbox(page);

  // A second visitor from another address (sandbox creation is limited per address), in the same
  // browser: its sign-in replaces the cookie, so every call below carries the second visitor's.
  await page.route(`${API}/**`, (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        'cf-connecting-ip': `2001:db8::${clientIp.split('.')[3]}`,
      },
    }),
  );
  await demoAccount(page);
  const second = await liveSandbox(page);
  expect(second.id).not.toBe(first.id);

  const own = await api(page, 'GET', `/v1/sandboxes/${second.id}/customers`);
  expect(own.status).toBe(200);

  for (const pathname of [
    `/v1/sandboxes/${first.id}`,
    `/v1/sandboxes/${first.id}/customers`,
    `/v1/sandboxes/${first.id}/inbox`,
  ]) {
    const across = await api<{ status: number; title: string }>(page, 'GET', pathname);
    expect(across.status, pathname).toBe(404);
    expect(across.body.status, pathname).toBe(404);
  }
});
