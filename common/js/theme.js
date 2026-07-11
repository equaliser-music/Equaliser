/* Equaliser theme bootstrap.
 * Synchronous, ES5-compatible, no modules. Must run before first paint on
 * pages that include it (placed immediately before the page <style> block).
 * Reads the saved theme preference and points the #eq-theme <link> at the
 * matching stylesheet. Falls back to 'classic' if anything is missing or
 * localStorage is unavailable (e.g. privacy mode).
 */
(function () {
  'use strict';

  // canvas = the theme's base page colour, painted onto <html> synchronously
  // so the browser's blank canvas between full-page navigations matches the
  // theme instead of flashing white. scheme drives the UA color-scheme.
  var EQ_THEMES = [
    { id: 'classic', label: 'Classic', canvas: '#0a0a0f', scheme: 'dark' },
    { id: 'signal',  label: 'Signal', canvas: '#f2f0ea', scheme: 'light' },
    { id: 'sleeve',  label: 'Sleeve', canvas: '#faf6ef', scheme: 'light' },
    { id: 'console', label: 'Console', canvas: '#131416', scheme: 'dark' },
    { id: 'flyposter', label: 'Flyposter', canvas: '#efe9dc', scheme: 'light' },
    { id: 'pirate', label: 'Pirate', canvas: '#07060c', scheme: 'dark' },
    { id: 'stencil', label: 'Stencil', canvas: '#b5977a', scheme: 'light' },
    { id: 'terminal', label: 'Terminal', canvas: '#0a0f0a', scheme: 'dark' },
    { id: 'xerox', label: 'Xerox', canvas: '#d8d5cc', scheme: 'light' }
  ];
  var STORAGE_KEY = 'equaliser_theme';

  function isValidTheme(name) {
    return EQ_THEMES.some(function (t) { return t.id === name; });
  }

  function readStoredTheme() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && isValidTheme(stored)) {
        return stored;
      }
    } catch (e) {
      /* localStorage unavailable — fall back to default */
    }
    return 'classic';
  }

  function writeStoredTheme(name) {
    try {
      window.localStorage.setItem(STORAGE_KEY, name);
    } catch (e) {
      /* ignore — best effort persistence only */
    }
  }

  function hrefFor(name) {
    return '/common/css/theme-' + name + '.css?v=1';
  }

  function applyThemeLink(name) {
    var href = hrefFor(name);
    var link = document.getElementById('eq-theme');

    if (link) {
      var existingHref = link.getAttribute('href') || '';
      if (existingHref.indexOf('theme-' + name + '.css') === -1) {
        link.setAttribute('href', href);
      }
      return link;
    }

    link = document.createElement('link');
    link.id = 'eq-theme';
    link.rel = 'stylesheet';
    link.href = href;

    var head = document.head || document.getElementsByTagName('head')[0];
    if (head) {
      var firstStyleish = head.querySelector('style, link[rel="stylesheet"]');
      if (firstStyleish) {
        head.insertBefore(link, firstStyleish);
      } else {
        head.appendChild(link);
      }
    }
    return link;
  }

  function themeEntry(name) {
    for (var i = 0; i < EQ_THEMES.length; i++) {
      if (EQ_THEMES[i].id === name) return EQ_THEMES[i];
    }
    return EQ_THEMES[0];
  }

  // Paint the root element in the theme's base colour immediately (before any
  // stylesheet loads) so full-page navigations never blank to white, and hint
  // the UA colour scheme so native chrome (scrollbars, form controls) matches.
  function applyCanvas(name) {
    var t = themeEntry(name);
    var root = document.documentElement;
    root.style.backgroundColor = t.canvas;
    root.style.colorScheme = t.scheme;
  }

  // Cross-document view transitions: supporting browsers (Chrome 126+,
  // Safari 18.2+) crossfade same-origin full-page navigations instead of
  // hard-swapping. Ignored everywhere else.
  function enableViewTransitions() {
    try {
      var style = document.createElement('style');
      style.id = 'eq-view-transitions';
      style.textContent = '@view-transition { navigation: auto; }';
      var head = document.head || document.getElementsByTagName('head')[0];
      if (head && !document.getElementById('eq-view-transitions')) head.appendChild(style);
    } catch (e) { /* best effort */ }
  }

  var currentTheme = readStoredTheme();
  applyCanvas(currentTheme);
  applyThemeLink(currentTheme);
  enableViewTransitions();

  window.EqTheme = {
    get: function () {
      return currentTheme;
    },
    set: function (name) {
      if (!isValidTheme(name)) {
        return;
      }
      currentTheme = name;
      writeStoredTheme(name);
      applyCanvas(name);
      applyThemeLink(name);
      try {
        window.dispatchEvent(new CustomEvent('equaliser:theme-changed', { detail: { theme: name } }));
      } catch (e) {
        /* CustomEvent unsupported — nothing more we can do */
      }
    },
    themes: function () {
      return EQ_THEMES.map(function (t) {
        return { id: t.id, label: t.label };
      });
    }
  };
})();
