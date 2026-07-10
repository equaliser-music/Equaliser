/* Equaliser theme bootstrap.
 * Synchronous, ES5-compatible, no modules. Must run before first paint on
 * pages that include it (placed immediately before the page <style> block).
 * Reads the saved theme preference and points the #eq-theme <link> at the
 * matching stylesheet. Falls back to 'classic' if anything is missing or
 * localStorage is unavailable (e.g. privacy mode).
 */
(function () {
  'use strict';

  var EQ_THEMES = [
    { id: 'classic', label: 'Classic' },
    { id: 'signal',  label: 'Signal' },
    { id: 'sleeve',  label: 'Sleeve' },
    { id: 'console', label: 'Console' },
    { id: 'flyposter', label: 'Flyposter' },
    { id: 'pirate', label: 'Pirate' }
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

  var currentTheme = readStoredTheme();
  applyThemeLink(currentTheme);

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
