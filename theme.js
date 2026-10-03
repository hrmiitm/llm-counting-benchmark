'use strict';

// Run before stylesheets to avoid flashing the opposite theme on navigation.
(() => {
  const key = 'count-compare-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let saved = null;
  try { const value = localStorage.getItem(key); if (value === 'light' || value === 'dark') saved = value; } catch { /* Storage can be unavailable in private or embedded contexts. */ }
  function apply(theme, announce = true) {
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
      button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    }
    if (announce) window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }
  apply(saved ?? (media.matches ? 'dark' : 'light'), false);
  document.addEventListener('DOMContentLoaded', () => {
    apply(document.documentElement.dataset.theme, false);
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      saved = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, saved); } catch { /* The choice still works for this page. */ }
      apply(saved);
    });
  });
  media.addEventListener('change', () => { if (!saved) apply(media.matches ? 'dark' : 'light'); });
  window.addEventListener('storage', event => {
    if (event.key !== key) return;
    saved = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
    apply(saved ?? (media.matches ? 'dark' : 'light'));
  });
})();
