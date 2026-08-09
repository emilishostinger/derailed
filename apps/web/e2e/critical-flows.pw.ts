/**
 * The dashboard flows that must never break, driven through a real browser against the
 * compiled binary.
 *
 * Three flows, chosen because they are the ones a broken build would strand a user on
 * and because none needs Docker, so they are deterministic: creating the very first
 * account, signing out and back in, and the role boundary this whole project is careful
 * about, that a viewer is not shown the machinery only an owner may touch. Deploy and
 * database flows are proven against real containers in the integration suite and on the
 * VPS smoke walk; they are deliberately not re-driven through the browser here, where a
 * container pull would make the run slow and flaky.
 *
 * One test, one page: onboarding can happen only once on a machine, and the account it
 * creates is what the rest signs in against, so running them as one sequence in a single
 * browser context is both faithful to what a person does and free of cross-test state.
 */
import { expect, type Page, test } from '@playwright/test';

const OWNER = { email: 'owner@e2e.test', password: 'e2e-owner-password' };
const VIEWER = { email: 'viewer@e2e.test', password: 'e2e-viewer-password' };

async function signIn(page: Page, who: typeof OWNER) {
  // The sign-in page's email field has no placeholder (only onboarding does), so match
  // it by type, which is stable on both pages.
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('onboarding, sign-out and sign-in, and the viewer role boundary', async ({
  page,
  browser,
}) => {
  // --- Onboarding: a brand-new machine, create the first account. ---
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill(OWNER.email);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill(OWNER.password);
  await passwords.nth(1).fill(OWNER.password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // --- Sign out and back in. Sign out lives in the account menu, opened by the trigger
  // that shows your address. ---
  await page.getByRole('button', { name: OWNER.email }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await signIn(page, OWNER);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // --- The role boundary: invite a viewer, and prove the dashboard hides owner-only
  // machinery from them. The People API is owner-only and this page carries the owner's
  // cookie; the CSRF header is what the app asks every write to send. ---
  const created = await page.request.post('/api/people', {
    headers: { 'x-requested-with': 'derailed' },
    data: { email: VIEWER.email, password: VIEWER.password, role: 'viewer' },
  });
  expect(created.ok()).toBeTruthy();

  // The owner, on the settings page, sees the people management, the viewer listed in it.
  await page.goto('/settings');
  await expect(page.getByText(VIEWER.email)).toBeVisible();

  // The viewer, in a clean context, does not: the whole people section is hidden for a
  // non-owner (shown-and-refused would be a worse explanation), so the owner's address
  // never appears on their settings page, though the role summary that tells them why
  // does.
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto('/');
  await signIn(viewerPage, VIEWER);
  await expect(viewerPage.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await viewerPage.goto('/settings');
  await expect(viewerPage.getByText('You can look at everything', { exact: false })).toBeVisible();
  await expect(viewerPage.getByText(OWNER.email)).toHaveCount(0);
  await viewerContext.close();
});
