/**
 * Stealth init script - injected into every page via addInitScript().
 * Runs BEFORE any page script so detection probes that read these
 * values during page load see the patched versions.
 *
 * Goal: make the browser look like a normal, manually-installed
 * Google Chrome on a regular desktop, NOT a Playwright/Chromium bot.
 */
const STEALTH_INIT = () => {
  try {
    // ---- 1. navigator.webdriver -------------------------------------
    // The #1 giveaway. Hide it completely.
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    // Legacy webdriver globals Playwright/Selenium leak.
    delete Navigator.prototype.__webdriver_evaluate;
    delete Navigator.prototype.__webdriver_scriptFunction;
    delete Navigator.prototype.__webdriver_scriptFunc;
    delete Navigator.prototype.__webdriver_evaluateFunc;
    delete Document.prototype.__webdriver_evaluate;
    delete Document.prototype.__webdriver_scriptFunction;
    delete Document.prototype.__webdriver_scriptFunc;
    delete Document.prototype.__webdriver_evaluateFunc;
    delete window.webdriver;
    delete window.__webdriver_evaluate;
    delete window.__webdriver_scriptFunction;
    delete window.__phantom;
    delete window.__nightmare;
    delete window._phantom;
    delete window.callPhantom;
    delete window._selenium;
    delete window.__webdriver_unwrap;
    delete window.__driver_evaluate;
    delete window.__webdriver_script_element;
    delete window.__webdriver_script_function;
    delete document.__selenium_unwrap;
    delete document.__webdriver_evaluate;
    delete document.__webdriver_script_function;
    delete document.__selenium_evaluate;
    delete document.__webdriver_script_element;

    // ---- 2. window.chrome --------------------------------------------
    // Real Chrome exposes a window.chrome object. Headless/Playwright
    // often lacks it, which is a strong headless signal.
    if (!window.chrome) {
      window.chrome = {};
    }
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: function () { return null; },
      getIsInstalled: function () { return false; },
    };
    window.chrome.csi = function () {
      return { onloadT: Date.now(), startE: Date.now(), pageT: 0, tran: 15 };
    };
    window.chrome.loadTimes = function () {
      const now = Date.now() / 1000;
      return {
        requestTime: now - 0.5,
        startLoadTime: now - 0.4,
        commitLoadTime: now - 0.35,
        finishDocumentLoadTime: now - 0.2,
        finishLoadTime: now - 0.1,
        firstPaintTime: now - 0.18,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      };
    };
    window.chrome.runtime = window.chrome.runtime || {
      OnInstalledReason: {
        CHROME_UPDATE: 'chrome_update',
        INSTALL: 'install',
        SHARED_MODULE_UPDATE: 'shared_module_update',
        UPDATE: 'update',
      },
      PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
      RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      connect: function () { return {}; },
      sendMessage: function () {},
    };

    // ---- 3. navigator.plugins & mimeTypes ---------------------------
    // Headless Chrome reports 0 plugins. Real Chrome has PDF, Native
    // Client, Chrome PDF Viewer, etc. Stub them so .length > 0 and
    // item/namedItem behave like a PluginArray.
    const makePlugin = (name, filename, description) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name:        { get: () => name },
        filename:    { get: () => filename },
        description: { get: () => description },
        length:      { get: () => 1 },
      });
      return plugin;
    };
    const plugins = [
      makePlugin('PDF Viewer',               'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chrome PDF Viewer',        'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chromium PDF Viewer',      'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Microsoft Edge PDF Viewer','internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('WebKit built-in PDF',      'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Native Client',            'internal-nacl-plugin','Native Client Executable'),
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const list = Object.create(PluginArray.prototype);
        plugins.forEach((p, i) => { list[i] = p; });
        Object.defineProperty(list, 'length', { get: () => plugins.length });
        list.item     = (i) => plugins[i] || null;
        list.namedItem = (n) => plugins.find(p => p.name === n) || null;
        list.refresh  = () => {};
        return list;
      },
      configurable: true,
    });
    const mimeTypes = [
      { type: 'application/pdf',                  suffixes: 'pdf', description: 'Portable Document Format',                enabledPlugin: plugins[0] },
      { type: 'application/x-google-chrome-pdf',  suffixes: 'pdf', description: 'Portable Document Format',                enabledPlugin: plugins[1] },
      { type: 'application/x-nacl',               suffixes: '',    description: 'Native Client Executable',                enabledPlugin: plugins[5] },
      { type: 'application/x-pnacl',              suffixes: '',    description: 'Portable Native Client Executable',      enabledPlugin: plugins[5] },
    ];
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const list = Object.create(MimeTypeArray.prototype);
        mimeTypes.forEach((m, i) => { list[i] = m; });
        Object.defineProperty(list, 'length', { get: () => mimeTypes.length });
        list.item     = (i) => mimeTypes[i] || null;
        list.namedItem = (n) => mimeTypes.find(m => m.type === n) || null;
        return list;
      },
      configurable: true,
    });

    // ---- 4. Permissions.query patch ----------------------------------
    // In headless, notifications.query sometimes returns inconsistent
    // results. Forward Notification.permission directly.
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : originalQuery(parameters);
    }

    // ---- 5. WebGL vendor/renderer ------------------------------------
    // Headless falls back to "SwiftShader" / "Google Inc." which is a
    // dead giveaway. Override with a realistic desktop GPU string.
    const patchGetParameter = (proto) => {
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        const UNMASKED_VENDOR_WEBGL   = 0x9245;
        const UNMASKED_RENDERER_WEBGL = 0x9246;
        if (p === UNMASKED_VENDOR_WEBGL)   return 'Intel Inc.';
        if (p === UNMASKED_RENDERER_WEBGL) return 'Intel Iris OpenGL Engine';
        return orig.call(this, p);
      };
    };
    if (window.WebGLRenderingContext)  patchGetParameter(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patchGetParameter(WebGL2RenderingContext.prototype);
    const origGetExt = WebGLRenderingContext.prototype.getExtension;
    WebGLRenderingContext.prototype.getExtension = function (name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return origGetExt.call(this, name);
    };

    // ---- 6. Languages ------------------------------------------------
    // Make sure navigator.languages matches the configured locale.
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
    Object.defineProperty(navigator, 'language', {
      get: () => 'en-US',
      configurable: true,
    });

    // ---- 7. CDP / Runtime.evaluate source detection ------------------
    // If the page calls Function.prototype.toString on patched natives,
    // make the output look like a normal toString() of a JS function.
    // We do this by wrapping the override ourselves with a clean toString.
    const wrapToString = (obj, prop, newFn) => {
      try {
        const orig = obj[prop];
        Object.defineProperty(newFn, 'toString', {
          value: function () { return 'function ' + prop + '() { [native code] }'; },
          configurable: true,
        });
        Object.defineProperty(newFn, 'name', { value: prop, configurable: true });
        obj[prop] = newFn;
      } catch (e) {}
    };
    // (Most detectors check webdriver & UA, not toString — left as a
    // hook for future tightening.)

    // ---- 8. Headless-specific globals --------------------------------
    // Belt-and-suspenders: if the UA ever contains "Headless" rewrite it.
    if (navigator.userAgent && /Headless/i.test(navigator.userAgent)) {
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: () => navigator.userAgent.replace(/Headless/i, ''),
        configurable: true,
      });
    }

    // ---- 9. Network connection ---------------------------------------
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
      configurable: true,
    });
  } catch (e) {
    // Never let stealth injection crash the page.
  }
};

module.exports = STEALTH_INIT;
