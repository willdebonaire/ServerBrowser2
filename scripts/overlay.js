#!/usr/bin/env node
/**
 * overlay.js — inject a VNC HUD overlay into the live Chrome session.
 *
 * The overlay shows:
 *   - Current action text
 *   - Progress bar
 *   - Notification popups (fade in/out)
 *   - Pause/resume buttons
 *
 * It is injected via CDP addInitScript so it persists across page navigations.
 * State is synchronized through localStorage events.
 *
 * IMPORTANT: this file is injected as *page* script text (see
 * scripts/vnc-driver.js), so it must never reference Node globals such as
 * `require`, `module`, `__dirname` or `process` outside of a typeof guard.
 * Runtime configuration is handed over by the driver via
 * `window.__serverbrowser_overlay_config` before this script runs.
 *
 * The public API is exposed as `window.__serverbrowser_overlay`:
 *   setText(text)         update the action line
 *   setProgress(0..100)   update the progress bar
 *   notify(text, ms)      show a fading notification
 *   pause() / resume()    toggle the paused flag (also toggled by the button)
 *   isPaused()            read the paused flag
 *   getState()            read the whole persisted state
 */

const OVERLAY_JS = () => {
  const STORAGE_KEY = 'serverbrowser_overlay_state';

  // Configuration is handed over by scripts/vnc-driver.js (Node side) as a
  // plain object on window, because a page script cannot read process.env.
  const CONFIG = (typeof window !== 'undefined' && window.__serverbrowser_overlay_config) || {};
  const OVERLAY_AUTO_HIDE_SECONDS = Number(CONFIG.autoHideSeconds != null ? CONFIG.autoHideSeconds : 10) || 0;

  const EMPTY_STATE = () => ({ text: '', progress: 0, paused: false, notifications: [] });

  const getState = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? { ...EMPTY_STATE(), ...parsed } : EMPTY_STATE();
    } catch {
      return EMPTY_STATE();
    }
  };
  
  const setState = (state) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(state) }));
    } catch {}
  };
  
  const mountPoint = () => document.body || document.documentElement || null;

  const ensureOverlay = () => {
    const existing = document.getElementById('serverbrowser-hud');
    if (existing) return existing.__serverbrowser_hud || null;
    const parent = mountPoint();
    if (!parent) return null;

    const hud = document.createElement('div');
    hud.id = 'serverbrowser-hud';
    Object.assign(hud.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      pointerEvents: 'none',
    });
    
    const inner = document.createElement('div');
    Object.assign(inner.style, {
      background: 'rgba(15, 23, 42, 0.92)',
      color: '#e2e8f0',
      padding: '10px 16px',
      margin: '8px',
      borderRadius: '10px',
      border: '1px solid #1f2937',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      flexWrap: 'wrap',
      pointerEvents: 'auto',
      backdropFilter: 'blur(8px)',
      transition: 'opacity 0.5s ease',
    });
    
    let lastUpdate = Date.now();
    
    const textEl = document.createElement('div');
    textEl.id = 'serverbrowser-hud-text';
    Object.assign(textEl.style, {
      flex: '1 1 auto',
      minWidth: '180px',
      fontSize: '13px',
      lineHeight: '1.4',
    });
    
    const progressContainer = document.createElement('div');
    Object.assign(progressContainer.style, {
      flex: '0 0 auto',
      width: '120px',
      height: '6px',
      background: '#1f2937',
      borderRadius: '3px',
      overflow: 'hidden',
    });
    
    const progressBar = document.createElement('div');
    progressBar.id = 'serverbrowser-hud-progress';
    Object.assign(progressBar.style, {
      width: '0%',
      height: '100%',
      background: '#38bdf8',
      borderRadius: '3px',
      transition: 'width 0.3s ease',
    });
    
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'serverbrowser-hud-pause';
    pauseBtn.textContent = 'Pause';
    Object.assign(pauseBtn.style, {
      flex: '0 0 auto',
      background: '#334155',
      color: '#e2e8f0',
      border: '1px solid #475569',
      borderRadius: '6px',
      padding: '4px 12px',
      fontSize: '12px',
      cursor: 'pointer',
      fontWeight: '600',
    });
    
    pauseBtn.addEventListener('click', () => {
      const current = getState();
      if (current.paused) {
        setState({ ...current, paused: false });
        pauseBtn.textContent = 'Pause';
        pauseBtn.style.background = '#334155';
      } else {
        setState({ ...current, paused: true });
        pauseBtn.textContent = 'Resume';
        pauseBtn.style.background = '#0f766e';
      }
    });
    
    progressContainer.appendChild(progressBar);
    inner.appendChild(textEl);
    inner.appendChild(progressContainer);
    inner.appendChild(pauseBtn);
    hud.appendChild(inner);
    
    const notificationsContainer = document.createElement('div');
    notificationsContainer.id = 'serverbrowser-hud-notifications';
    Object.assign(notificationsContainer.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column-reverse',
      gap: '8px',
      pointerEvents: 'none',
      maxWidth: '320px',
    });
    hud.appendChild(notificationsContainer);
    
    parent.appendChild(hud);
    
    const api = {
      textEl,
      progressBar,
      pauseBtn,
      notificationsContainer,
      inner,
      getLastUpdate: () => lastUpdate,
      resetLastUpdate: () => { lastUpdate = Date.now(); },
    };
    hud.__serverbrowser_hud = api;
    return api;
  };
  
  const renderNotifications = (container, notifications) => {
    container.innerHTML = '';
    notifications.forEach((n) => {
      const el = document.createElement('div');
      el.textContent = n.text;
      Object.assign(el.style, {
        background: 'rgba(15, 23, 42, 0.95)',
        color: '#e2e8f0',
        padding: '8px 12px',
        borderRadius: '8px',
        border: '1px solid #1f2937',
        fontSize: '12px',
        lineHeight: '1.4',
        pointerEvents: 'auto',
        animation: 'serverbrowser-fadein 0.3s ease',
      });
      container.appendChild(el);
      
      setTimeout(() => {
        el.style.animation = 'serverbrowser-fadeout 0.5s ease forwards';
        setTimeout(() => el.remove(), 500);
      }, n.duration || 4000);
    });
  };
  
  const sync = () => {
    const state = getState();
    const els = ensureOverlay();
    if (!els) return false; // document not mounted yet — DOMContentLoaded will call us again

    const { textEl, progressBar, pauseBtn, notificationsContainer, inner: hudInner, getLastUpdate, resetLastUpdate } = els;

    resetLastUpdate();
    hudInner.style.opacity = '';

    textEl.textContent = state.text || '';
    progressBar.style.width = `${Math.min(100, Math.max(0, state.progress || 0))}%`;

    // Keep the button label in step with the state, including changes made from
    // the agent side (scripts/live.js `pause` / `resume`).
    if (pauseBtn) {
      pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
      pauseBtn.style.background = state.paused ? '#0f766e' : '#334155';
    }

    if (state.notifications && state.notifications.length > 0) {
      renderNotifications(notificationsContainer, state.notifications);
      setState({ ...state, notifications: [] });
    }

    if (OVERLAY_AUTO_HIDE_SECONDS > 0) {
      clearInterval(sync._hideTimer);
      sync._hideTimer = setInterval(() => {
        if (Date.now() - getLastUpdate() > OVERLAY_AUTO_HIDE_SECONDS * 1000) {
          hudInner.style.opacity = '0';
        }
      }, OVERLAY_AUTO_HIDE_SECONDS * 500);
    }
    return true;
  };
  
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) sync();
  });
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes serverbrowser-fadein {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes serverbrowser-fadeout {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(-8px); }
    }
  `;
  if (document.head) document.head.appendChild(style);

  // addInitScript runs before the document body exists, so the HUD is mounted
  // as soon as a mount point is available (immediately, or on DOMContentLoaded).
  if (!sync()) {
    document.addEventListener('DOMContentLoaded', () => sync(), { once: true });
  }

  return {
    setText: (text) => {
      const state = getState();
      setState({ ...state, text: String(text) });
      sync();
    },
    setProgress: (value) => {
      const state = getState();
      setState({ ...state, progress: Number(value) });
      sync();
    },
    notify: (text, duration) => {
      const state = getState();
      const notifications = state.notifications || [];
      notifications.push({ text: String(text), duration: Number(duration) || 4000, timestamp: Date.now() });
      setState({ ...state, notifications: notifications.slice(-5) });
      sync();
    },
    pause: () => {
      setState({ ...getState(), paused: true });
      sync();
      return { paused: true };
    },
    resume: () => {
      setState({ ...getState(), paused: false });
      sync();
      return { paused: false };
    },
    isPaused: () => {
      return getState().paused || false;
    },
    getState: () => getState(),
  };
};

if (typeof window !== 'undefined') {
  window.__serverbrowser_overlay = OVERLAY_JS();
}
