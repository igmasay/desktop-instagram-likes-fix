// ==UserScript==
// @name         Instagram Liked Posts: Open in New Tabs
// @namespace    https://github.com/openai/codex
// @version      3.2.0
// @description  Adds direct, new-tab links to the tiles in Instagram's liked-posts history.
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-idle
// @sandbox      DOM
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_VERSION = '3.2.0';
  console.log(`[Instagram liked-post links v${SCRIPT_VERSION}] loaded`);

  function unwrapPageObject(value) {
    return value;
  }

  const pageWindow = globalThis;
  const pageDocument = document;

  /*
   * Instagram is a single-page React application, so the grid and its tiles
   * can be replaced while the page is open.  The observer below deliberately
   * re-scans instead of relying on one fixed set of class names.
   */
  const STYLE_ID = 'tm-instagram-liked-posts-new-tabs-style';
  const TILE_MARKER = 'data-tm-instagram-liked-post-tile';
  const LINK_MARKER = 'data-tm-instagram-liked-post-link';
  const ANCHOR_MARKER = 'data-tm-instagram-liked-post-anchor';
  const CONTROL_MARKER = 'data-tm-instagram-liked-post-control';
  const POSITION_MARKER = 'data-tm-instagram-liked-post-position';
  const ORIGINAL_TARGET = 'data-tm-instagram-liked-post-original-target';
  const ORIGINAL_REL = 'data-tm-instagram-liked-post-original-rel';
  const ORIGINAL_HREF = 'data-tm-instagram-liked-post-original-href';
  const CONTROL_POSITION = 'data-tm-instagram-liked-post-control-position';
  const MISSING_ATTRIBUTE = '__tm_attribute_was_missing__';
  const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const MEDIA_ID_DIGITS = 19;

  const POST_PATH_RE = /(?:https?:\/\/(?:www\.)?instagram\.com)?(\/(p|reel|tv)\/([A-Za-z0-9_-]+))(?:[/?#]|$)/i;
  const MEDIA_ID_ATTRIBUTE_RE = /(?:^|[-_])(media[-_]?id|media[-_]?pk|pk)(?:$|[-_])/i;
  const MEDIA_CODE_KEY_RE = /^(?:shortcode|short_code|media_code|code)$/i;
  const MEDIA_ID_KEY_RE = /^(?:media[_-]?(?:id|pk)|mediaId|mediaPk)$/i;
  const MEDIA_LIKE_KEYS = new Set([
    'carousel_media',
    'display_url',
    'displayUrl',
    'image_versions2',
    'is_video',
    'isVideo',
    'media_type',
    'mediaType',
    'product_type',
    'thumbnail_src',
    'taken_at',
    'video_versions',
  ]);

  let scanFrame = 0;
  let lastLocation = pageWindow.location.href;
  let lastScanReport = '';

  function reportScriptError(phase, error) {
    console.error(`[Instagram liked-post links v${SCRIPT_VERSION}] ${phase} failed`, error);
  }

  function isElement(value) {
    return Boolean(value && value.nodeType === 1 && typeof value.querySelectorAll === 'function');
  }

  function safeText(value) {
    return typeof value === 'string' ? value : '';
  }

  function normaliseCode(value) {
    const code = safeText(value).trim();
    return /^[A-Za-z0-9_-]{2,120}$/.test(code) ? code : null;
  }

  function routeFromValue(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const decoded = value
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');
    const match = decoded.match(POST_PATH_RE);

    if (!match) {
      return null;
    }

    return {
      code: match[3],
      kind: match[2].toLowerCase(),
      path: `/${match[2].toLowerCase()}/${match[3]}/`,
    };
  }

  function absoluteInstagramUrl(path) {
    return new URL(path, pageWindow.location.origin).href;
  }

  function numberFromValue(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }

    if (typeof value === 'string' && /^\d{5,30}$/.test(value)) {
      const normalised = value.replace(/^0+/, '');
      return normalised || null;
    }

    return null;
  }

  // Instagram shortcodes are the URL-safe base-64 representation of the
  // numeric media ID.  This lets the script recover a permalink when the DOM
  // exposes a media ID but no href/code.
  function shortcodeFromMediaId(value) {
    let digits = numberFromValue(value);
    if (digits === null) {
      return null;
    }

    let shortcode = '';
    while (digits !== '0') {
      let remainder = 0;
      let quotient = '';

      for (const character of digits) {
        const divided = remainder * 10 + Number(character);
        const quotientDigit = Math.floor(divided / 64);
        remainder = divided % 64;
        if (quotient || quotientDigit > 0) {
          quotient += String(quotientDigit);
        }
      }

      shortcode = SHORTCODE_ALPHABET[remainder] + shortcode;
      digits = quotient || '0';
    }

    return shortcode || null;
  }

  function identityFromThumbnail(value) {
    if (typeof value !== 'string' || !value) {
      return null;
    }

    let cacheKey = null;
    try {
      cacheKey = new URL(value, 'https://www.instagram.com/').searchParams.get('ig_cache_key');
    } catch (_error) {
      return null;
    }

    if (!cacheKey) {
      return null;
    }

    try {
      const encoded = cacheKey
        .split('.')[0]
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      if (!encoded) {
        return null;
      }

      const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const decoded = globalThis.atob(padded).match(/^\d+/)?.[0];
      if (!decoded || decoded.length < MEDIA_ID_DIGITS) {
        return null;
      }

      const mediaId = decoded.slice(0, MEDIA_ID_DIGITS);
      const code = shortcodeFromMediaId(mediaId);
      if (!code) {
        return null;
      }

      return {
        code,
        kind: 'p',
        mediaId,
        path: `/p/${code}/`,
      };
    } catch (_error) {
      return null;
    }
  }

  function kindFromObject(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const typeValues = [
      value.product_type,
      value.productType,
      value.media_type,
      value.mediaType,
      value.content_type,
      value.contentType,
    ];

    if (typeValues.some((type) => /reel|clips/i.test(safeText(type)))) {
      return 'reel';
    }

    return null;
  }

  function looksLikeMediaObject(value) {
    if (!value || typeof value !== 'object') {
      return false;
    }

    return Object.keys(value).some((key) => MEDIA_LIKE_KEYS.has(key));
  }

  function getReactRoots(element) {
    const roots = [];
    const seenFibers = new Set();
    const pageElement = unwrapPageObject(element);
    const reactElements = [pageElement];
    try {
      reactElements.push(...pageElement.querySelectorAll('img, video, [data-testid="bulk_action_checkbox"]'));
    } catch (_error) {
      // The tile may have been detached during a React render.
    }

    for (const reactElement of reactElements) {
      let current = unwrapPageObject(reactElement);
      let ancestorDepth = 0;

      while (isElement(current) && ancestorDepth < 4) {
        let propertyNames = [];
        try {
          propertyNames = Object.getOwnPropertyNames(current);
        } catch (_error) {
          propertyNames = [];
        }

        for (const propertyName of propertyNames) {
          let value;
          try {
            value = unwrapPageObject(current[propertyName]);
          } catch (_error) {
            continue;
          }

          if (propertyName.startsWith('__reactProps$')) {
            roots.push(value);
            continue;
          }

          if (!propertyName.startsWith('__reactFiber$') && !propertyName.startsWith('__reactInternalInstance$')) {
            continue;
          }

          let fiber = value;
          let fiberDepth = 0;
          while (fiber && fiberDepth < 8 && !seenFibers.has(fiber)) {
            seenFibers.add(fiber);
            if (fiber.memoizedProps) {
              roots.push(unwrapPageObject(fiber.memoizedProps));
            }
            if (fiber.pendingProps) {
              roots.push(unwrapPageObject(fiber.pendingProps));
            }
            fiber = unwrapPageObject(fiber.return);
            fiberDepth += 1;
          }
        }

        current = unwrapPageObject(current.parentElement);
        ancestorDepth += 1;
      }
    }

    return roots;
  }

  function inspectReactValue(root) {
    const seen = new WeakSet();
    const queue = [{ value: unwrapPageObject(root), depth: 0 }];
    let inspected = 0;
    let fallbackId = null;
    let fallbackKind = null;

    while (queue.length && inspected < 1600) {
      const entry = queue.shift();
      const value = unwrapPageObject(entry.value);
      const depth = entry.depth;

      if (typeof value === 'string') {
        const route = routeFromValue(value);
        if (route) {
          return route;
        }
        continue;
      }

      if (!value || typeof value !== 'object' || depth > 7) {
        continue;
      }

      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      inspected += 1;

      const mediaLike = looksLikeMediaObject(value);
      const objectKind = kindFromObject(value);
      if (objectKind) {
        fallbackKind = objectKind;
      }

      let keys;
      try {
        keys = Object.keys(value).slice(0, 100);
      } catch (_error) {
        continue;
      }

      // Check direct media fields before walking children.  This avoids
      // accidentally choosing a user's ID nested inside a media object.
      for (const key of keys) {
        let child;
        try {
          child = unwrapPageObject(value[key]);
        } catch (_error) {
          continue;
        }

        if (MEDIA_CODE_KEY_RE.test(key)) {
          const code = normaliseCode(child);
          if (code) {
            const kind = objectKind || fallbackKind || 'p';
            return {
              code,
              kind,
              path: `/${kind === 'reel' ? 'reel' : 'p'}/${code}/`,
            };
          }
        }

        if (MEDIA_ID_KEY_RE.test(key)) {
          const mediaId = numberFromValue(child);
          if (mediaId !== null && fallbackId === null) {
            fallbackId = mediaId;
          }
        }

        if ((key === 'pk' || key === 'id') && mediaLike && fallbackId === null) {
          const mediaId = numberFromValue(child);
          if (mediaId !== null) {
            fallbackId = mediaId;
          }
        }
      }

      if (depth === 7) {
        continue;
      }

      for (const key of keys) {
        let child;
        try {
          child = unwrapPageObject(value[key]);
        } catch (_error) {
          continue;
        }

        if (child && typeof child === 'object') {
          queue.push({ value: child, depth: depth + 1 });
        } else if (typeof child === 'string') {
          const route = routeFromValue(child);
          if (route) {
            return route;
          }
        }
      }
    }

    if (fallbackId !== null) {
      const code = shortcodeFromMediaId(fallbackId);
      if (code) {
        return {
          code,
          kind: fallbackKind || 'p',
          mediaId: fallbackId.toString(),
          path: `/${fallbackKind === 'reel' ? 'reel' : 'p'}/${code}/`,
        };
      }
    }

    return null;
  }

  function findRouteInSubtree(tile) {
    const elements = [tile];
    try {
      elements.push(...tile.querySelectorAll('*'));
    } catch (_error) {
      // The tile may have been detached during a React render.
    }

    for (const element of elements) {
      if (!isElement(element)) {
        continue;
      }

      for (const attribute of Array.from(element.attributes)) {
        const route = routeFromValue(attribute.value);
        if (route) {
          return route;
        }
      }
    }

    return routeFromValue(tile.outerHTML || '');
  }

  function findMediaIdInAttributes(tile) {
    const elements = [tile];
    try {
      elements.push(...tile.querySelectorAll('*'));
    } catch (_error) {
      // The tile may have been detached during a React render.
    }

    for (const element of elements) {
      if (!isElement(element)) {
        continue;
      }

      for (const attribute of Array.from(element.attributes)) {
        if (!MEDIA_ID_ATTRIBUTE_RE.test(attribute.name)) {
          continue;
        }

        const mediaId = numberFromValue(attribute.value);
        if (mediaId !== null) {
          return mediaId;
        }
      }
    }

    return null;
  }

  function findPostInfoFromThumbnail(tile) {
    const mediaElements = [tile];
    try {
      mediaElements.push(...tile.querySelectorAll('img, video'));
    } catch (_error) {
      // The tile may have been detached during a React render.
    }

    for (const media of mediaElements) {
      const sources = [];
      try {
        sources.push(media.currentSrc, media.src, media.getAttribute('src'));
        const srcset = media.getAttribute('srcset');
        if (srcset) {
          sources.push(...srcset.split(/\s+/).map((source) => source.replace(/,$/, '')));
        }
      } catch (_error) {
        continue;
      }

      for (const source of sources) {
        const identity = identityFromThumbnail(source);
        if (identity) {
          return identity;
        }
      }
    }

    return null;
  }

  function findPostInfo(tile) {
    const route = findRouteInSubtree(tile);
    if (route) {
      return route;
    }

    const thumbnailIdentity = findPostInfoFromThumbnail(tile);
    if (thumbnailIdentity) {
      return thumbnailIdentity;
    }

    let idFallback = findMediaIdInAttributes(tile);
    let kindFallback = null;

    for (const root of getReactRoots(tile)) {
      const reactInfo = inspectReactValue(root);
      if (!reactInfo) {
        continue;
      }

      if (reactInfo.path) {
        return reactInfo;
      }

      if (!idFallback && reactInfo.mediaId) {
        idFallback = numberFromValue(reactInfo.mediaId);
      }
      if (reactInfo.kind) {
        kindFallback = reactInfo.kind;
      }
    }

    if (!idFallback) {
      return null;
    }

    const code = shortcodeFromMediaId(idFallback);
    if (!code) {
      return null;
    }

    const kind = kindFallback || 'p';
    return {
      code,
      kind,
      mediaId: idFallback.toString(),
      path: `/${kind === 'reel' ? 'reel' : 'p'}/${code}/`,
    };
  }

  function rectangleFor(element) {
    if (!isElement(element)) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }

    return null;
  }

  function containsRectangle(container, child) {
    return container.left <= child.left + 2
      && container.top <= child.top + 2
      && container.right >= child.right - 2
      && container.bottom >= child.bottom - 2;
  }

  function isCloseToMedia(rect, mediaRect) {
    const widthRatio = rect.width / mediaRect.width;
    const heightRatio = rect.height / mediaRect.height;
    return widthRatio >= 0.88
      && heightRatio >= 0.88
      && widthRatio <= 1.45
      && heightRatio <= 1.45;
  }

  function mediaCount(element) {
    return element.querySelectorAll('img, video').length;
  }

  function findTileForMedia(media) {
    const mediaRect = rectangleFor(media);
    if (!mediaRect) {
      return null;
    }

    const nearestAnchor = media.closest('a');
    if (nearestAnchor) {
      const anchorRect = rectangleFor(nearestAnchor);
      if (anchorRect && containsRectangle(anchorRect, mediaRect) && isCloseToMedia(anchorRect, mediaRect)) {
        return nearestAnchor;
      }
    }

    let best = null;
    let current = media;
    let depth = 0;

    while (isElement(current) && depth < 10) {
      const rect = rectangleFor(current);
      if (rect && containsRectangle(rect, mediaRect)) {
        const count = mediaCount(current);
        const semanticTile = current.matches('article, [role="button"], [tabindex="0"]');

        if (count > 1 && current !== media) {
          break;
        }

        if (count === 1 && isCloseToMedia(rect, mediaRect)) {
          best = current;
          if (semanticTile) {
            return current;
          }
        }
      }

      current = current.parentElement;
      depth += 1;
    }

    if (best === media && media.parentElement) {
      return media.parentElement;
    }

    return best;
  }

  function findTileForCheckbox(checkbox) {
    let current = checkbox;
    let depth = 0;

    while (isElement(current) && depth < 8) {
      const media = current.querySelector('img, video');
      if (media && mediaCount(current) === 1) {
        const tile = findTileForMedia(media);
        if (tile) {
          return tile;
        }
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function isLikelyLikedPostsSurface() {
    const path = pageWindow.location.pathname.toLowerCase();
    if (path.includes('liked') || path.includes('/your_activity/interactions')) {
      return true;
    }

    const bodyText = safeText(pageDocument.body?.innerText).slice(0, 20000).toLowerCase();
    return bodyText.includes('sort & filter')
      && (bodyText.includes('newest to oldest') || bodyText.includes('select'));
  }

  function isLikelyGridMedia(media) {
    if (!isElement(media) || media.closest('nav, header, footer, dialog, [role="dialog"]')) {
      return false;
    }

    const rect = rectangleFor(media);
    if (!rect || Math.max(rect.width, rect.height) < 90) {
      return false;
    }

    const aspectRatio = rect.width / rect.height;
    return aspectRatio >= 0.45 && aspectRatio <= 2.2;
  }

  function rememberAttribute(element, attributeName, dataName) {
    if (element.hasAttribute(dataName)) {
      return;
    }

    element.setAttribute(
      dataName,
      element.hasAttribute(attributeName) ? element.getAttribute(attributeName) : MISSING_ATTRIBUTE,
    );
  }

  function restoreAttribute(element, attributeName, dataName) {
    if (!element.hasAttribute(dataName)) {
      return;
    }

    const originalValue = element.getAttribute(dataName);
    if (originalValue === MISSING_ATTRIBUTE) {
      element.removeAttribute(attributeName);
    } else {
      element.setAttribute(attributeName, originalValue);
    }
    element.removeAttribute(dataName);
  }

  function setNewTabAttributes(anchor) {
    anchor.setAttribute('target', '_blank');
    const relValues = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
    relValues.add('noopener');
    relValues.add('noreferrer');
    anchor.setAttribute('rel', Array.from(relValues).join(' '));
  }

  function enhanceExistingAnchor(anchor, url) {
    rememberAttribute(anchor, 'target', ORIGINAL_TARGET);
    rememberAttribute(anchor, 'rel', ORIGINAL_REL);
    rememberAttribute(anchor, 'href', ORIGINAL_HREF);

    if (!routeFromValue(anchor.getAttribute('href') || '')) {
      anchor.setAttribute('href', url);
    }
    setNewTabAttributes(anchor);
    anchor.setAttribute(ANCHOR_MARKER, '1');
  }

  function markControls(tile) {
    const controls = tile.querySelectorAll(
      'button, input, [role="button"], [role="checkbox"], [aria-label*="select" i], [data-testid*="select" i], [data-testid="bulk_action_checkbox"]',
    );

    for (const control of controls) {
      if (control.hasAttribute(LINK_MARKER)) {
        continue;
      }

      if (!control.hasAttribute(CONTROL_MARKER) && pageWindow.getComputedStyle(control).position === 'static') {
        control.setAttribute(CONTROL_POSITION, control.style.position || MISSING_ATTRIBUTE);
        control.style.position = 'relative';
      }
      control.setAttribute(CONTROL_MARKER, '1');
    }
  }

  function createOverlayLink(tile, url) {
    let link = tile.querySelector(`:scope > a[${LINK_MARKER}]`);
    if (!link) {
      link = pageDocument.createElement('a');
      link.setAttribute(LINK_MARKER, '1');
      link.addEventListener('click', (event) => event.stopPropagation());
      link.addEventListener('auxclick', (event) => event.stopPropagation());
      tile.appendChild(link);
    }

    // Remove the optional visual badge while keeping the full-tile anchor.
    link.textContent = '';

    if (link.href !== url) {
      link.href = url;
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Open post in a new tab';
    link.setAttribute('aria-label', 'Open Instagram post in a new tab');
    tile.setAttribute(TILE_MARKER, '1');

    if (!tile.hasAttribute(POSITION_MARKER) && pageWindow.getComputedStyle(tile).position === 'static') {
      tile.setAttribute(POSITION_MARKER, tile.style.position || MISSING_ATTRIBUTE);
      tile.style.position = 'relative';
    }

    markControls(tile);
  }

  function decorateTile(tile, info) {
    const url = absoluteInstagramUrl(info.path);

    if (tile.tagName === 'A') {
      enhanceExistingAnchor(tile, url);
      return;
    }

    const directAnchor = tile.querySelector(`:scope > a:not([${LINK_MARKER}])`);
    if (directAnchor && rectangleFor(directAnchor) && rectangleFor(tile)) {
      const tileRect = rectangleFor(tile);
      const anchorRect = rectangleFor(directAnchor);
      if (anchorRect && tileRect && isCloseToMedia(anchorRect, tileRect)) {
        enhanceExistingAnchor(directAnchor, url);
        return;
      }
    }

    createOverlayLink(tile, url);
  }

  function removeInjectedLinks() {
    for (const link of Array.from(pageDocument.querySelectorAll(`a[${LINK_MARKER}]`))) {
      const tile = link.parentElement;
      link.remove();

      if (!tile) {
        continue;
      }

      for (const control of Array.from(tile.querySelectorAll(`[${CONTROL_MARKER}]`))) {
        if (control.hasAttribute(CONTROL_POSITION)) {
          const originalPosition = control.getAttribute(CONTROL_POSITION);
          control.style.position = originalPosition === MISSING_ATTRIBUTE ? '' : originalPosition;
          control.removeAttribute(CONTROL_POSITION);
        }
        control.removeAttribute(CONTROL_MARKER);
      }

      if (tile.hasAttribute(POSITION_MARKER)) {
        const originalPosition = tile.getAttribute(POSITION_MARKER);
        tile.style.position = originalPosition === MISSING_ATTRIBUTE ? '' : originalPosition;
        tile.removeAttribute(POSITION_MARKER);
      }
      tile.removeAttribute(TILE_MARKER);
    }

    for (const anchor of Array.from(pageDocument.querySelectorAll(`a[${ANCHOR_MARKER}]`))) {
      restoreAttribute(anchor, 'target', ORIGINAL_TARGET);
      restoreAttribute(anchor, 'rel', ORIGINAL_REL);
      restoreAttribute(anchor, 'href', ORIGINAL_HREF);
      anchor.removeAttribute(ANCHOR_MARKER);
    }
  }

  function reportScan(mediaCountFound, tileCount, linkedTileCount, unresolvedTileCount) {
    const report = [
      `[Instagram liked-post links v${SCRIPT_VERSION} realm=dom]`,
      `media=${mediaCountFound}`,
      `tiles=${tileCount}`,
      `links=${linkedTileCount}`,
      `unresolved=${unresolvedTileCount}`,
    ].join(' ');

    if (report !== lastScanReport) {
      lastScanReport = report;
      console.log(report);
    }
  }

  function reportInactiveSurface() {
    const report = `[Instagram liked-post links] inactive on ${pageWindow.location.pathname}`;
    if (report !== lastScanReport) {
      lastScanReport = report;
      console.log(report);
    }
  }

  function scan() {
    scanFrame = 0;

    if (!isLikelyLikedPostsSurface()) {
      reportInactiveSurface();
      removeInjectedLinks();
      return;
    }

    const tiles = new Set();
    const mediaElements = Array.from(pageDocument.querySelectorAll('img, video'));
    for (const media of mediaElements) {
      if (!isLikelyGridMedia(media)) {
        continue;
      }

      const tile = findTileForMedia(media);
      if (tile) {
        tiles.add(tile);
      }
    }

    for (const checkbox of Array.from(pageDocument.querySelectorAll('[data-testid="bulk_action_checkbox"]'))) {
      const tile = findTileForCheckbox(checkbox);
      if (tile) {
        tiles.add(tile);
      }
    }

    let linkedTileCount = 0;
    let unresolvedTileCount = 0;
    for (const tile of tiles) {
      if (!isElement(tile) || !tile.isConnected) {
        continue;
      }

      const info = findPostInfo(tile);
      if (info?.path) {
        decorateTile(tile, info);
        linkedTileCount += 1;
      } else {
        unresolvedTileCount += 1;
      }
    }

    reportScan(mediaElements.length, tiles.size, linkedTileCount, unresolvedTileCount);
  }

  function safeScan() {
    try {
      scan();
    } catch (error) {
      reportScriptError('scan', error);
    }
  }

  function scheduleScan() {
    if (scanFrame) {
      return;
    }

    try {
      if (typeof globalThis.requestAnimationFrame === 'function') {
        scanFrame = globalThis.requestAnimationFrame(safeScan);
      } else {
        scanFrame = globalThis.setTimeout(safeScan, 0);
      }
    } catch (error) {
      reportScriptError('schedule scan', error);
    }
  }

  function installStyles() {
    if (pageDocument.getElementById(STYLE_ID)) {
      return;
    }

    const style = pageDocument.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      a[${LINK_MARKER}] {
        align-items: flex-start;
        background: transparent !important;
        color: transparent !important;
        cursor: pointer !important;
        display: flex !important;
        inset: 0 !important;
        justify-content: flex-end;
        pointer-events: auto !important;
        position: absolute !important;
        text-decoration: none !important;
        z-index: 2147483646 !important;
      }

      [${CONTROL_MARKER}] {
        z-index: 2147483647 !important;
      }

      [${TILE_MARKER}] {
        isolation: isolate !important;
      }
    `;
    pageDocument.head.appendChild(style);
  }

  function watchNavigation() {
    for (const methodName of ['pushState', 'replaceState']) {
      try {
        const originalMethod = pageWindow.history[methodName];
        if (typeof originalMethod !== 'function') {
          continue;
        }

        pageWindow.history[methodName] = function patchedHistoryMethod(...args) {
          const result = originalMethod.apply(this, args);
          queueMicrotask(() => {
            if (lastLocation !== pageWindow.location.href) {
              lastLocation = pageWindow.location.href;
              scheduleScan();
            }
          });
          return result;
        };
      } catch (error) {
        reportScriptError(`navigation hook (${methodName})`, error);
      }
    }

    try {
      pageWindow.addEventListener('popstate', () => {
        lastLocation = pageWindow.location.href;
        scheduleScan();
      });
    } catch (error) {
      reportScriptError('popstate hook', error);
    }
  }

  function start() {
    console.log(`[Instagram liked-post links v${SCRIPT_VERSION}] starting body=${Boolean(pageDocument.body)}`);
    scheduleScan();

    try {
      installStyles();
    } catch (error) {
      reportScriptError('style installation', error);
    }

    watchNavigation();

    try {
      // Use the constructor from the userscript realm. Firefox can reject
      // an observe() options object when the constructor comes from the page
      // realm and the options object comes from the userscript realm.
      const Observer = globalThis.MutationObserver;
      const observer = new Observer(() => scheduleScan());
      observer.observe(pageDocument.body, {
        attributes: true,
        attributeFilter: [
          'src',
          'srcset',
          'href',
          'data-testid',
          'data-media-id',
          'data-media-pk',
          'data-pk',
        ],
        childList: true,
        subtree: true,
      });
    } catch (error) {
      reportScriptError('mutation observer', error);
    }
  }

  try {
    start();
  } catch (error) {
    reportScriptError('startup', error);
  }
})();
