/**
 * Example: log into a site, stay logged in across runs, and
 * capture a screenshot of the result.
 *
 * Run 1: visit /login, fill form, click submit.  Profile is saved.
 * Run 2: visit /home directly — cookies keep you signed in.
 */
const { launch, DEFAULT_PROFILE } = require('./headless');

(async () => {
  const { page, human, screenshot, close } = await launch({
    url: 'https://example.com/login',
    profileDir: DEFAULT_PROFILE,
  });

  // Wait for page load, then act like a human:
  await human.wait(1500);
  await human.type('input[name=email]',    'me@example.com');
  await human.think();
  await human.type('input[name=password]', 'hunter2');
  await human.pause();
  await human.click('button[type=submit]');

  // Wait for navigation, then take a screenshot of the result.
  await page.waitForLoadState('networkidle');
  const out = await screenshot('login-result.png', { fullPage: true });
  console.log('Logged in, screenshot saved to', out);

  await close();
})();
