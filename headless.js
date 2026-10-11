module.exports = {
  headless: {},
  launch: async (options) => {
    delete options.url;
    delete options.waitUntil;
    delete options.timeout;
    const { default: Browser } = await require("puppeteer");
    const browser = await Browser.launch({ headless: options.headless || false, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    return {
      page: await browser.newPage(),
      close: async () => {
        try { await browser.close(); } catch {}
      }
    };
  }
}
