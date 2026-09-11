// ==UserScript==
// @name         Instagram Media Downloader + Liked Posts
// @namespace    https://github.com/openai/codex/instagram-media-tools
// @version      1.3.0
// @description  Download the current Instagram post or open liked posts in new tabs.
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-idle
// @noframes
// @inject-into  page
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      instagram.com
// @connect      cdninstagram.com
// @connect      fbcdn.net
// ==/UserScript==

"use strict";

(() => {
  const ROOT_CLASS = "igd-post-root";
  const BUTTON_CLASS = "igd-download-button";
  const FLOATING_BUTTON_CLASS = "igd-download-floating";
  const MAX_MEDIA_PER_POST = 20;
  const MIN_MEDIA_EDGE = 120;

  const DOWNLOADER_STYLE_ID = "igd-userscript-style";
  const DOWNLOADER_STYLE = ".igd-post-root {\n  position: relative !important;\n}\n\n.igd-download-button {\n  all: unset;\n  align-items: center !important;\n  background: rgba(0, 0, 0, 0.72) !important;\n  border: 1px solid rgba(255, 255, 255, 0.35) !important;\n  border-radius: 999px !important;\n  box-sizing: border-box !important;\n  color: #fff !important;\n  cursor: pointer !important;\n  display: flex !important;\n  height: 42px !important;\n  justify-content: center !important;\n  padding: 0 !important;\n  position: absolute !important;\n  right: 16px !important;\n  top: 16px !important;\n  transition: background-color 140ms ease, color 140ms ease, transform 140ms ease, opacity 140ms ease !important;\n  width: 42px !important;\n  z-index: 2147483647 !important;\n}\n\n.igd-download-button.igd-download-floating {\n  left: auto !important;\n  position: fixed !important;\n  right: auto !important;\n  top: auto !important;\n}\n\n.igd-download-button:hover {\n  background: #fff !important;\n  color: #000 !important;\n  transform: scale(1.06) !important;\n}\n\n.igd-download-button:focus-visible {\n  outline: 2px solid #fff !important;\n  outline-offset: 3px !important;\n}\n\n.igd-download-button:disabled {\n  cursor: wait !important;\n}\n\n.igd-download-icon {\n  fill: none !important;\n  height: 22px !important;\n  stroke: currentColor !important;\n  stroke-linecap: round !important;\n  stroke-linejoin: round !important;\n  stroke-width: 1.9 !important;\n  width: 22px !important;\n}\n\n.igd-download-spinner {\n  border: 2px solid currentColor !important;\n  border-right-color: transparent !important;\n  border-radius: 50% !important;\n  display: none !important;\n  height: 18px !important;\n  width: 18px !important;\n}\n\n.igd-download-button[data-igd-state=\"loading\"] .igd-download-icon {\n  display: none !important;\n}\n\n.igd-download-button[data-igd-state=\"loading\"] .igd-download-spinner {\n  animation: igd-spin 700ms linear infinite !important;\n  display: block !important;\n}\n\n.igd-download-button[data-igd-state=\"success\"] {\n  background: #1d9b55 !important;\n}\n\n.igd-download-button[data-igd-state=\"error\"] {\n  background: #c93636 !important;\n}\n\n@keyframes igd-spin {\n  to {\n    transform: rotate(360deg);\n  }\n}\n";

  function installDownloaderStyles() {
    if (document.getElementById(DOWNLOADER_STYLE_ID)) return;

    try {
      if (typeof GM_addStyle === "function") {
        const style = GM_addStyle(DOWNLOADER_STYLE);
        if (style) style.id = DOWNLOADER_STYLE_ID;
        return;
      }
    } catch (_error) {
      // Fall back to a normal style element if the manager cannot add it.
    }

    const style = document.createElement("style");
    style.id = DOWNLOADER_STYLE_ID;
    style.textContent = DOWNLOADER_STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  let mountedRoot = null;
  let mountedButton = null;
  let mountedMedia = null;
  let mountedPostKey = "";
  let mutationObserver = null;
  let syncTimer = null;

  function isInstagramHost() {
    return /^(?:www\.)?instagram\.com$/i.test(globalThis.location.hostname);
  }

  function getPostInfo() {
    if (!isInstagramHost()) return null;

    const path = globalThis.location.pathname.replace(/^\/+|\/+$/g, "");
    const parts = path.split("/");

    if (parts.length !== 2 || !["p", "reel", "reels"].includes(parts[0].toLowerCase())) {
      return null;
    }

    let shortcode;

    try {
      shortcode = decodeURIComponent(parts[1]);
    } catch (_error) {
      return null;
    }

    if (!shortcode || shortcode.includes("/")) return null;

    return {
      shortcode,
      kind: parts[0].toLowerCase()
    };
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;

    const style = globalThis.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function parseDimension(element, attribute, fallback) {
    const value = Number(element.getAttribute(attribute));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function getElementSize(element) {
    if (element instanceof HTMLVideoElement) {
      return {
        width: element.videoWidth || element.clientWidth || 0,
        height: element.videoHeight || element.clientHeight || 0
      };
    }

    return {
      width: element.naturalWidth || element.clientWidth || parseDimension(element, "width", 0),
      height: element.naturalHeight || element.clientHeight || parseDimension(element, "height", 0)
    };
  }

  function getLargestSrcsetUrl(srcset) {
    if (!srcset) return "";

    return srcset
      .split(",")
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        const widthMatch = parts[1] && parts[1].match(/^(\d+)w$/);

        return {
          url: parts[0],
          width: widthMatch ? Number(widthMatch[1]) : 0
        };
      })
      .filter((candidate) => candidate.url)
      .sort((left, right) => right.width - left.width)[0]?.url || "";
  }

  function isUsableUrl(value) {
    if (typeof value !== "string" || !value.trim()) return false;

    try {
      const url = new URL(value, globalThis.location.href);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  function normalizeMediaUrl(value) {
    if (!isUsableUrl(value)) return "";

    const url = new URL(value, globalThis.location.href);
    for (const parameter of [...url.searchParams.keys()]) {
      if (/^byte(?:start|end)$/i.test(parameter)) {
        url.searchParams.delete(parameter);
      }
    }
    return url.href;
  }

  function getMediaUrl(element) {
    const candidates = [];

    if (element instanceof HTMLVideoElement) {
      candidates.push(element.currentSrc, element.src, element.getAttribute("src"));
      candidates.push(...[...element.querySelectorAll("source")].flatMap((source) => [
        source.currentSrc,
        source.src,
        source.getAttribute("src")
      ]));
    } else {
      candidates.push(element.currentSrc, element.src, getLargestSrcsetUrl(element.getAttribute("srcset")));
    }

    return candidates.find((candidate) => isUsableUrl(candidate)) || "";
  }

  function looksLikeInterfaceImage(element, size) {
    const alt = (element.getAttribute("alt") || "").toLowerCase();
    const label = (element.getAttribute("aria-label") || "").toLowerCase();
    const combinedLabel = `${alt} ${label}`;

    if (/(profile picture|avatar|logo|icon|emoji|sticker)/.test(combinedLabel)) {
      return true;
    }

    const maxDimension = Math.max(size.width, size.height);
    const renderedSize = element.getBoundingClientRect();
    const maxRenderedDimension = Math.max(renderedSize.width, renderedSize.height);

    // Profile images can have a large source file but are rendered as tiny circles.
    const isTinyRenderedImage = maxRenderedDimension > 0 && maxRenderedDimension < 80;
    const isSmallSourceImage = maxDimension > 0 && maxDimension < 240 && maxRenderedDimension < 240;

    return isTinyRenderedImage || isSmallSourceImage;
  }

  function isLikelyPostMedia(element, visibleOnly = false) {
    if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) {
      return false;
    }

    if (visibleOnly && !isVisible(element)) return false;

    const size = getElementSize(element);
    if (element instanceof HTMLImageElement && looksLikeInterfaceImage(element, size)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const renderedWidth = rect.width;
    const renderedHeight = rect.height;
    const sourceWidth = size.width;
    const sourceHeight = size.height;

    return (
      (renderedWidth >= MIN_MEDIA_EDGE && renderedHeight >= MIN_MEDIA_EDGE) ||
      (sourceWidth >= MIN_MEDIA_EDGE && sourceHeight >= MIN_MEDIA_EDGE)
    );
  }

  function getMediaElements(scope, visibleOnly = false) {
    return [...scope.querySelectorAll("video, img")].filter((element) =>
      isLikelyPostMedia(element, visibleOnly)
    );
  }

  function getDocumentTop(element) {
    return element.getBoundingClientRect().top + (globalThis.scrollY || 0);
  }

  function scoreMediaElement(element) {
    const size = getElementSize(element);
    const rect = element.getBoundingClientRect();
    return Math.max(size.width, rect.width) * Math.max(size.height, rect.height);
  }

  function getVisibleMediaArea(element, root) {
    const mediaRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    let left = Math.max(mediaRect.left, rootRect.left);
    let right = Math.min(mediaRect.right, rootRect.right);
    let top = Math.max(mediaRect.top, rootRect.top);
    let bottom = Math.min(mediaRect.bottom, rootRect.bottom);

    for (let ancestor = element.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      const style = globalThis.getComputedStyle(ancestor);
      const clipsX = style.overflowX !== "visible";
      const clipsY = style.overflowY !== "visible";

      if (!clipsX && !clipsY) continue;

      const ancestorRect = ancestor.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, ancestorRect.left);
        right = Math.min(right, ancestorRect.right);
      }
      if (clipsY) {
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
    }

    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function getActiveMediaElements(root, mediaElements) {
    if (mediaElements.length <= 1) return mediaElements;

    const scored = mediaElements.map((element) => ({
      element,
      area: getVisibleMediaArea(element, root),
      score: scoreMediaElement(element),
      centerDistance: Math.abs(
        element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2 -
        (root.getBoundingClientRect().left + root.getBoundingClientRect().width / 2)
      )
    }));
    const maxArea = Math.max(...scored.map((item) => item.area));

    if (maxArea <= 0) {
      scored.sort((left, right) => left.centerDistance - right.centerDistance || right.score - left.score);
    } else {
      scored.sort((left, right) => right.area - left.area || left.centerDistance - right.centerDistance || right.score - left.score);
    }

    const active = scored[0]?.element;
    if (!active) return [];

    // A video and its poster can occupy the same active frame. Prefer the
    // video representation so a poster is never downloaded instead of video.
    const activeFrame = scored.filter((item) =>
      item.area === scored[0].area && item.centerDistance === scored[0].centerDistance
    ).map((item) => item.element);
    const activeVideos = activeFrame.filter((element) => element instanceof HTMLVideoElement);

    return activeVideos.length ? [activeVideos[0]] : [active];
  }

  function getSlideGroup(element, root) {
    for (let ancestor = element.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      if (
        ancestor.tagName === "LI" ||
        ancestor.getAttribute("role") === "group" ||
        ancestor.getAttribute("aria-roledescription") === "slide" ||
        ancestor.hasAttribute("data-index")
      ) {
        return ancestor;
      }
    }

    return element;
  }

  function getActiveSlideIndex(root, mediaElements, activeMedia) {
    if (!mediaElements.length || !activeMedia.length) return 0;

    const groups = [];
    mediaElements.forEach((element) => {
      const group = getSlideGroup(element, root);
      if (!groups.includes(group)) groups.push(group);
    });

    const activeGroup = getSlideGroup(activeMedia[0], root);
    const groupIndex = groups.indexOf(activeGroup);
    return groupIndex >= 0 ? groupIndex : 0;
  }

  function getMediaScope() {
    const visibleDialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);

    // A Direct conversation can remain open behind the post viewer and also
    // contain media. Pick the dialog with the largest rendered media instead
    // of whichever dialog happens to come first in the DOM.
    const dialogCandidates = visibleDialogs
      .map((dialog) => ({
        dialog,
        media: getMediaElements(dialog, true)
      }))
      .filter((candidate) => candidate.media.length)
      .sort((left, right) => {
        const leftScore = Math.max(...left.media.map(scoreMediaElement));
        const rightScore = Math.max(...right.media.map(scoreMediaElement));
        return rightScore - leftScore || right.media.length - left.media.length;
      });

    if (dialogCandidates[0]) return dialogCandidates[0].dialog;

    return document.querySelector("main") || document.body;
  }

  function findPrimaryMediaElement() {
    const scope = getMediaScope();
    let candidates = getMediaElements(scope, true);

    // Some carousel slides briefly render without intrinsic dimensions while
    // Instagram is swapping the active slide. Use their rendered frame as a
    // short-lived anchor so the control can mount during that transition too.
    if (!candidates.length) {
      candidates = [...scope.querySelectorAll("video, img")].filter((element) => {
        if (!isVisible(element)) return false;

        const size = getElementSize(element);
        const rect = element.getBoundingClientRect();
        return (
          !(
            element instanceof HTMLImageElement &&
            looksLikeInterfaceImage(element, size)
          ) &&
          Math.max(rect.width, rect.height) >= MIN_MEDIA_EDGE
        );
      });
    }

    return candidates.sort((left, right) => {
      const topDifference = getDocumentTop(left) - getDocumentTop(right);

      // The direct post appears before the recommended-post grid on the explicit
      // post page. Prefer that first media cluster over lower-page thumbnails.
      if (Math.abs(topDifference) > 24) return topDifference;

      return scoreMediaElement(right) - scoreMediaElement(left);
    })[0] || null;
  }

  function isTightMediaGroup(elements, primaryMedia) {
    const primaryRect = primaryMedia.getBoundingClientRect();
    const primaryTop = getDocumentTop(primaryMedia);
    const maxDistance = Math.max(320, primaryRect.height * 0.8);

    return elements.every((element) => {
      const rect = element.getBoundingClientRect();

      // Hidden carousel slides have no layout box but still have useful src/srcset data.
      if (!rect.width || !rect.height) return true;

      return Math.abs(getDocumentTop(element) - primaryTop) <= maxDistance;
    });
  }

  function findMediaContainer(primaryMedia, scope) {
    const primaryRect = primaryMedia.getBoundingClientRect();
    let best = primaryMedia.parentElement || scope;
    let candidate = best;

    while (candidate && candidate !== scope && candidate !== document.body) {
      if (!isVisible(candidate)) break;

      const rect = candidate.getBoundingClientRect();
      const mediaElements = getMediaElements(candidate);
      const isTooSmall =
        rect.width < primaryRect.width * 0.75 ||
        rect.height < primaryRect.height * 0.75;
      const isTooLarge =
        rect.width > Math.max(primaryRect.width * 1.5, primaryRect.width + 200) ||
        rect.height > Math.max(primaryRect.height * 1.5, primaryRect.height + 200);

      if (
        !mediaElements.includes(primaryMedia) ||
        mediaElements.length > MAX_MEDIA_PER_POST ||
        isTooLarge ||
        !isTightMediaGroup(mediaElements, primaryMedia)
      ) {
        break;
      }

      // Instagram's carousel list can collapse to a narrow strip while its
      // absolutely positioned slides overflow it. Skip that wrapper and keep
      // climbing until we reach the visible frame that actually bounds them.
      if (isTooSmall) {
        candidate = candidate.parentElement;
        continue;
      }

      best = candidate;

      // The first ancestor containing more than one nearby media element is
      // usually the carousel viewport. Do not climb into the page's suggestions.
      if (mediaElements.length > 1) break;

      candidate = candidate.parentElement;
    }

    return best;
  }

  function findPostRoot() {
    const primaryMedia = findPrimaryMediaElement();
    if (!primaryMedia) {
      const semanticRoot = [...document.querySelectorAll(
        '[role="dialog"] article, main article, article'
      )].find(isVisible);

      if (semanticRoot) return semanticRoot;

      const visibleDialog = [...document.querySelectorAll('[role="dialog"]')].find((dialog) =>
        isVisible(dialog) && getMediaElements(dialog, true).length
      );
      if (visibleDialog) return visibleDialog;

      const main = document.querySelector('main, [role="main"]');
      if (!main || !isVisible(main)) return null;

      // On some direct carousel pages the media frame is a direct child of
      // main, without an article or dialog wrapper. Keep the button out of
      // the recommendation grid by choosing that first media-bearing child.
      return [...main.children].find((child) =>
        getMediaElements(child, true).length || child.querySelector("video, img")
      ) || main;
    }

    const scope = getMediaScope();
    const article = primaryMedia.closest("article");
    if (article && isVisible(article)) {
      const articleMedia = getMediaElements(article);
      if (isTightMediaGroup(articleMedia, primaryMedia)) return article;
    }

    const dialog = primaryMedia.closest('[role="dialog"]');
    if (dialog && isVisible(dialog)) {
      const dialogMedia = getMediaElements(dialog);
      if (isTightMediaGroup(dialogMedia, primaryMedia)) return dialog;
    }

    return findMediaContainer(primaryMedia, scope);
  }

  function getPageVideoElements(root) {
    const videos = [...document.querySelectorAll("video")]
      .filter((video) => {
        if (!isVisible(video)) return false;
        if (isLikelyPostMedia(video, true)) return true;

        const rect = video.getBoundingClientRect();
        return Math.max(rect.width, rect.height) >= MIN_MEDIA_EDGE;
      });

    const scopedVideos = root && typeof root.contains === "function"
      ? videos.filter((video) => root.contains(video))
      : [];
    const candidates = scopedVideos.length ? scopedVideos : videos;

    return candidates.sort((left, right) => {
      const leftArea = root && root.contains(left) ? getVisibleMediaArea(left, root) : 0;
      const rightArea = root && root.contains(right) ? getVisibleMediaArea(right, root) : 0;
      return rightArea - leftArea || scoreMediaElement(right) - scoreMediaElement(left);
    });
  }

  function findButtonAnchorMedia(root) {
    if (!root || typeof root.contains !== "function") return null;

    const primaryMedia = findPrimaryMediaElement();
    if (primaryMedia && root.contains(primaryMedia)) return primaryMedia;

    const visibleMedia = getMediaElements(root, true);
    const activeMedia = getActiveMediaElements(root, visibleMedia)[0];
    if (activeMedia) return activeMedia;

    // Message-opened posts can render their player outside the article node
    // chosen by findPostRoot(). Use the largest visible video on the page as
    // an anchor so the control is still positioned with the opened post.
    const pageVideos = getPageVideoElements(root);
    return pageVideos[0] || visibleMedia[0] || null;
  }

  function isSameMediaCluster(left, right) {
    if (!left || !right || !left.isConnected || !right.isConnected) return false;

    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    if (!leftRect.width || !leftRect.height || !rightRect.width || !rightRect.height) return false;

    const maxDistance = Math.max(320, leftRect.height * 0.8, rightRect.height * 0.8);
    return Math.abs(getDocumentTop(left) - getDocumentTop(right)) <= maxDistance;
  }

  function positionButton(button = mountedButton, root = mountedRoot, media = mountedMedia) {
    if (!button) return;

    const mediaRect = media?.isConnected ? media.getBoundingClientRect() : null;
    const rootRect = root?.getBoundingClientRect?.() || {
      width: document.documentElement.clientWidth || globalThis.innerWidth || 0,
      height: document.documentElement.clientHeight || globalThis.innerHeight || 0
    };

    const viewportWidth = globalThis.innerWidth || document.documentElement.clientWidth || rootRect.width;
    const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight || rootRect.height;

    const buttonRect = button.getBoundingClientRect();
    const buttonWidth = buttonRect.width || 42;
    const buttonHeight = buttonRect.height || 42;
    const maxLeft = Math.max(8, viewportWidth - buttonWidth - 8);
    const maxTop = Math.max(8, viewportHeight - buttonHeight - 8);

    // The control belongs to the explicit post URL, not to a scrolling
    // article/recommendations container. Keep it fixed so Direct viewers and
    // virtualized reels cannot move it off-screen. When the media frame is
    // known, place it beside that frame; otherwise use a safe viewport corner.
    const mediaOnScreen = mediaRect && mediaRect.width && mediaRect.height &&
      mediaRect.bottom > 0 && mediaRect.top < viewportHeight &&
      mediaRect.right > 0 && mediaRect.left < viewportWidth;
    const left = mediaOnScreen
      ? Math.min(maxLeft, Math.max(8, mediaRect.right - buttonWidth - 16))
      : Math.max(8, viewportWidth - buttonWidth - 16);
    const top = mediaOnScreen
      ? Math.min(maxTop, Math.max(8, mediaRect.top + 16))
      : 16;

    button.classList.add(FLOATING_BUTTON_CLASS);
    // The stylesheet uses !important to survive Instagram's global button
    // rules, so the calculated coordinates must use the same priority.
    button.style.setProperty("left", `${Math.round(left)}px`, "important");
    button.style.setProperty("top", `${Math.round(top)}px`, "important");
    button.style.setProperty("right", "auto", "important");
    // Keep the control available while the direct post's player is being
    // scrolled or temporarily replaced by Instagram's virtualized reel view.
    button.style.visibility = "visible";
  }

  function addMedia(media, element, fallbackType) {
    const rawUrl = getMediaUrl(element);
    const url = normalizeMediaUrl(rawUrl);
    if (!url) return;
    const size = getElementSize(element);

    if (element instanceof HTMLImageElement && looksLikeInterfaceImage(element, size)) {
      return;
    }

    if (media.some((item) => item.url === url)) return;

    media.push({
      url,
      mediaType: fallbackType,
      width: size.width,
      height: size.height
    });
  }

  function addUrlCandidate(candidates, value, mediaType, width = 0, height = 0) {
    const url = typeof value === "string" ? value : value?.url;
    const normalizedUrl = normalizeMediaUrl(url);
    if (!normalizedUrl) return;

    const candidateTypes = value && typeof value === "object"
      ? [value.mime_type, value.mimeType, value.content_type, value.contentType]
      : [];
    const candidateType = candidateTypes.find(
      (type) => typeof type === "string" && type.includes("/")
    ) || mediaType;

    candidates.push({
      url: normalizedUrl,
      mediaType: candidateType,
      width: Number(value?.width) || width,
      height: Number(value?.height) || height
    });
  }

  function pickBestCandidate(candidates) {
    return candidates
      .filter((candidate) => isUsableUrl(candidate.url))
      .sort((left, right) => {
        const leftArea = (left.width || 0) * (left.height || 0);
        const rightArea = (right.width || 0) * (right.height || 0);
        return rightArea - leftArea || (right.width || 0) - (left.width || 0);
      })[0] || null;
  }

  function addVersionCandidates(target, value, mediaType) {
    if (!Array.isArray(value)) return;

    value.forEach((candidate) => {
      addUrlCandidate(target, candidate, mediaType);
    });
  }

  function collectEmbeddedMediaFromObject(node, media, visited = new Set()) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    const videoCandidates = [];
    addVersionCandidates(videoCandidates, node.video_versions, "video/mp4");
    addVersionCandidates(videoCandidates, node.videoVersions, "video/mp4");
    addUrlCandidate(videoCandidates, node.video_url, "video/mp4");
    addUrlCandidate(videoCandidates, node.videoUrl, "video/mp4");

    const structuredType = String(node["@type"] || "").toLowerCase();
    if (structuredType.includes("video")) {
      addUrlCandidate(videoCandidates, node.contentUrl, "video/mp4");
    }

    const bestVideo = pickBestCandidate(videoCandidates);
    if (bestVideo && !media.some((item) => item.url === bestVideo.url)) {
      media.push(bestVideo);
    }

    const imageCandidates = [];
    addVersionCandidates(imageCandidates, node.image_versions2?.candidates, "image/jpeg");
    addVersionCandidates(imageCandidates, node.imageVersions2?.candidates, "image/jpeg");
    addUrlCandidate(imageCandidates, node.display_url, "image/jpeg");
    addUrlCandidate(imageCandidates, node.displayUrl, "image/jpeg");
    addUrlCandidate(imageCandidates, node.display_uri, "image/jpeg");
    addUrlCandidate(imageCandidates, node.displayUri, "image/jpeg");
    addUrlCandidate(imageCandidates, node.image_url, "image/jpeg");
    addUrlCandidate(imageCandidates, node.imageUrl, "image/jpeg");
    addUrlCandidate(imageCandidates, node.thumbnail_url, "image/jpeg");
    addUrlCandidate(imageCandidates, node.thumbnailUrl, "image/jpeg");
    addUrlCandidate(imageCandidates, node.thumbnail_src, "image/jpeg");
    addUrlCandidate(imageCandidates, node.thumbnailUrl, "image/jpeg");

    const bestImage = pickBestCandidate(imageCandidates);
    if (bestImage && !media.some((item) => item.url === bestImage.url)) {
      media.push(bestImage);
    }

    getEmbeddedCarouselItems(node).forEach((item) => {
      collectEmbeddedMediaFromObject(item, media, visited);
    });
  }

  function getEmbeddedCarouselItems(node) {
    const values = [
      node?.carousel_media,
      node?.carouselMedia,
      node?.sidecar_children,
      node?.sidecarChildren,
      node?.children,
      node?.edge_sidecar_to_children,
      node?.edgeSidecarToChildren
    ];

    return values.flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.edges)) return value.edges;
      if (Array.isArray(value?.nodes)) return value.nodes;
      return [];
    }).map((item) => item?.node || item);
  }

  function getEmbeddedCarouselLength(node) {
    return getEmbeddedCarouselItems(node).length;
  }

  function getEmbeddedObjectScore(node) {
    const videoVersions = [node.video_versions, node.videoVersions].find(Array.isArray);
    const imageCandidates = node.image_versions2?.candidates || node.imageVersions2?.candidates;
    const hasVideoUrl = typeof node.video_url === "string" || typeof node.videoUrl === "string";
    const hasImageUrl = [
      node.display_url,
      node.displayUrl,
      node.display_uri,
      node.displayUri,
      node.image_url,
      node.imageUrl,
      node.thumbnail_url,
      node.thumbnailUrl,
      node.thumbnail_src
    ].some((value) => typeof value === "string" && value.length > 0);

    return (
      (videoVersions?.length || 0) * 1000000 +
      (hasVideoUrl ? 500000 : 0) +
      (Array.isArray(imageCandidates) ? imageCandidates.length : 0) * 10000 +
      (hasImageUrl ? 5000 : 0) +
      getEmbeddedCarouselLength(node) * 1000
    );
  }

  function isMatchingPostObject(node, shortcode) {
    if (!node || typeof node !== "object") return false;

    return [node.code, node.shortcode, node.media?.code, node.media?.shortcode].some(
      (value) => typeof value === "string" && value === shortcode
    );
  }

  function findObjectByShortcode(node, shortcode, visited = new Set(), depth = 0) {
    if (!node || typeof node !== "object" || visited.has(node) || depth > 60) return null;
    visited.add(node);

    let bestMatch = isMatchingPostObject(node, shortcode) ? node : null;
    let bestScore = bestMatch ? getEmbeddedObjectScore(bestMatch) : -1;

    const values = Array.isArray(node) ? node : Object.values(node);
    for (const value of values) {
      const match = findObjectByShortcode(value, shortcode, visited, depth + 1);
      if (!match) continue;

      const score = getEmbeddedObjectScore(match);
      if (score > bestScore) {
        bestMatch = match;
        bestScore = score;
      }
    }

    return bestMatch;
  }

  function parseScriptJson(source) {
    const text = String(source || "").trim();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (_error) {
      // Some Instagram payloads are assigned to a global instead of being pure JSON.
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace < 0 || lastBrace <= firstBrace) return null;

      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (_nestedError) {
        return null;
      }
    }
  }

  function getEmbeddedPostMedia(shortcode) {
    for (const script of document.scripts) {
      const source = script.textContent || "";
      if (!source.includes(shortcode)) continue;

      const parsed = parseScriptJson(source);
      const postObject = findObjectByShortcode(parsed, shortcode);
      if (!postObject) continue;

      const carouselItems = getEmbeddedCarouselItems(postObject);
      if (carouselItems.length > 1) {
        const carouselMedia = carouselItems.map((item) => {
          const slideMedia = [];
          collectEmbeddedMediaFromObject(item, slideMedia);

          return slideMedia.find((candidate) => candidate.mediaType.startsWith("video/")) ||
            slideMedia.find((candidate) => candidate.mediaType.startsWith("image/")) ||
            null;
        }).filter(Boolean);

        if (carouselMedia.length) return carouselMedia.slice(0, MAX_MEDIA_PER_POST);
      }

      const media = [];
      collectEmbeddedMediaFromObject(postObject, media);

      if (!media.length) continue;

      const hasVideo = media.some((item) => item.mediaType.startsWith("video/"));
      return (hasVideo ? media.filter((item) => item.mediaType.startsWith("video/")) : media).slice(
        0,
        MAX_MEDIA_PER_POST
      );
    }

    return [];
  }

  function getReactMediaRoots() {
    const roots = [];
    const seenRoots = new Set();
    const elements = [];
    const seenElements = new Set();

    const addElement = (element) => {
      if (!(element instanceof Element) || seenElements.has(element)) return;
      seenElements.add(element);
      elements.push(element);
    };

    addElement(mountedMedia);
    addElement(mountedRoot);

    for (const scope of [getMediaScope(), document.body]) {
      if (!(scope instanceof Element)) continue;
      addElement(scope);
      try {
        scope.querySelectorAll("video, img").forEach(addElement);
      } catch (_error) {
        // Instagram may detach the viewer while React is rendering it.
      }
    }

    for (const element of elements) {
      let current = element;
      let ancestorDepth = 0;

      while (current && ancestorDepth < 6) {
        let propertyNames = [];
        try {
          propertyNames = Object.getOwnPropertyNames(current);
        } catch (_error) {
          propertyNames = [];
        }

        for (const propertyName of propertyNames) {
          if (!propertyName.startsWith("__reactProps$") &&
              !propertyName.startsWith("__reactFiber$") &&
              !propertyName.startsWith("__reactInternalInstance$")) {
            continue;
          }

          let value;
          try {
            value = current[propertyName];
          } catch (_error) {
            continue;
          }

          if (propertyName.startsWith("__reactProps$")) {
            if (value && typeof value === "object" && !seenRoots.has(value)) {
              seenRoots.add(value);
              roots.push(value);
            }
            continue;
          }

          const seenFibers = new Set();
          let fiber = value;
          let fiberDepth = 0;
          while (fiber && typeof fiber === "object" && fiberDepth < 10 && !seenFibers.has(fiber)) {
            seenFibers.add(fiber);

            for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
              if (props && typeof props === "object" && !seenRoots.has(props)) {
                seenRoots.add(props);
                roots.push(props);
              }
            }

            fiber = fiber.return;
            fiberDepth += 1;
          }
        }

        current = current.parentElement;
        ancestorDepth += 1;
      }
    }

    return roots;
  }

  function findReactPostObject(root, shortcode) {
    const queue = [{ value: root, depth: 0 }];
    const visited = new Set();
    let bestMatch = null;
    let bestScore = -1;
    let inspected = 0;

    while (queue.length && inspected < 5000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || visited.has(value) || depth > 12) continue;
      visited.add(value);
      inspected += 1;

      if (isMatchingPostObject(value, shortcode)) {
        const score = getEmbeddedObjectScore(value);
        if (score > bestScore) {
          bestMatch = value;
          bestScore = score;
        }
      }

      let keys = [];
      try {
        keys = Object.keys(value).slice(0, 140);
      } catch (_error) {
        continue;
      }

      for (const key of keys) {
        let child;
        try {
          child = value[key];
        } catch (_error) {
          continue;
        }

        if (!child || typeof child !== "object" || child instanceof Node) continue;
        queue.push({ value: child, depth: depth + 1 });
      }
    }

    return bestMatch;
  }

  function collectReactObjectMedia(postObject) {
    const media = [];
    const objects = [
      postObject,
      postObject?.media,
      postObject?.data,
      postObject?.data?.media
    ];
    const uniqueObjects = objects.filter((object, index) =>
      object && typeof object === "object" && objects.indexOf(object) === index
    );

    const carouselOwner = uniqueObjects.find((object) => getEmbeddedCarouselItems(object).length > 1);
    if (carouselOwner) {
      const carouselMedia = getEmbeddedCarouselItems(carouselOwner).map((item) => {
        const slideMedia = [];
        collectEmbeddedMediaFromObject(item, slideMedia);
        return slideMedia.find((candidate) => candidate.mediaType.startsWith("video/")) ||
          slideMedia.find((candidate) => candidate.mediaType.startsWith("image/")) ||
          null;
      }).filter(Boolean);

      if (carouselMedia.length) return carouselMedia.slice(0, MAX_MEDIA_PER_POST);
    }

    uniqueObjects.forEach((object) => collectEmbeddedMediaFromObject(object, media));
    const hasVideo = media.some((item) => item.mediaType.startsWith("video/"));
    return (hasVideo ? media.filter((item) => item.mediaType.startsWith("video/")) : media)
      .slice(0, MAX_MEDIA_PER_POST);
  }

  function getReactEmbeddedPostMedia(shortcode) {
    for (const root of getReactMediaRoots()) {
      const postObject = findReactPostObject(root, shortcode);
      if (!postObject) continue;

      const media = collectReactObjectMedia(postObject);
      if (media.length) return media;
    }

    return [];
  }

  function getMetadataMedia() {
    const media = [];
    const image = document.querySelector('meta[property="og:image"]')?.content;
    const video = document.querySelector(
      'meta[property="og:video:secure_url"], meta[property="og:video"]'
    )?.content;

    if (isUsableUrl(video)) {
      media.push({ url: normalizeMediaUrl(video), mediaType: "video/mp4" });
    }

    if (isUsableUrl(image)) {
      media.push({ url: normalizeMediaUrl(image), mediaType: "image/jpeg" });
    }

    return media;
  }

  function getPerformanceVideoMedia() {
    if (!globalThis.performance?.getEntriesByType) return [];

    const candidates = globalThis.performance
      .getEntriesByType("resource")
      .map((entry) => {
        if (!isUsableUrl(entry.name)) return null;

        try {
          const url = new URL(entry.name);
          const isInstagramMediaHost = /(?:^|\.)instagram\.com$|(?:^|\.)cdninstagram\.com$|(?:^|\.)fbcdn\.net$/i.test(
            url.hostname
          );
          const resourceText = `${url.pathname}${url.search}`;
          const entryType = String(entry.initiatorType || entry.mimeType || "").toLowerCase();
          const isImageResource = /\.(?:jpe?g|png|gif|webp)(?:$|[?#])/i.test(url.href);
          const isVideoResource =
            /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(url.href) ||
            entryType === "video" ||
            entryType.startsWith("video/") ||
            (!isImageResource && /\/(?:o\d+\/)?v\/t\d+(?:[./]|\/)/i.test(resourceText)) ||
            /\/videoplayback(?:\/|$)/i.test(resourceText) ||
            /(?:mime[_-]?type|content[_-]?type)=video(?:%2f|\/)mp4/i.test(resourceText);

          if (!isInstagramMediaHost || !isVideoResource) return null;

          // Firefox records Instagram's byte-range requests with these query
          // parameters. Downloading that recorded URL saves only one fragment,
          // which looks like an MP4 but cannot be opened. The signed URL itself
          // is the complete asset when the range markers are removed.
          url.searchParams.delete("bytestart");
          url.searchParams.delete("byteend");

          return {
            url: url.href,
            mediaType: /\.webm(?:$|[?#])/i.test(url.href)
              ? "video/webm"
              : /\.mov(?:$|[?#])/i.test(url.href)
                ? "video/quicktime"
                : "video/mp4",
            size: Number(entry.decodedBodySize || entry.transferSize || 0),
            startTime: Number(entry.startTime || 0)
          };
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.size - left.size || right.startTime - left.startTime);

    return candidates.slice(0, 1).map(({ url, mediaType }) => ({ url, mediaType }));
  }

  function getPostMedia(root, shortcode) {
    // A post opened from Direct can live inside a page-wide main element.
    // Narrow media discovery back down to the container around the actual
    // post media so chat thumbnails and suggested posts are not candidates.
    const workingRoot = root || document.body;
    const mediaRoot = mountedMedia?.isConnected && workingRoot.contains(mountedMedia)
      ? findMediaContainer(mountedMedia, workingRoot)
      : workingRoot;
    const allMediaElements = getMediaElements(mediaRoot);
    const scopedVideos = allMediaElements.filter((element) => element instanceof HTMLVideoElement);
    const pageVideos = getPageVideoElements(workingRoot);
    const videoElements = scopedVideos.length ? scopedVideos : pageVideos;
    const activeMediaElements = getActiveMediaElements(mediaRoot, allMediaElements);
    const activeVideoElements = getActiveMediaElements(mediaRoot, videoElements);
    const postInfo = getPostInfo();
    const hasVideoElement = videoElements.length > 0 || mediaRoot.querySelector("video") !== null;
    const routeIsVideo = hasVideoElement || /reel/i.test(postInfo?.kind || "");
    const media = [];
    const videos = activeVideoElements.filter((element) => element instanceof HTMLVideoElement);
    const images = activeMediaElements.filter((element) => element instanceof HTMLImageElement);
    const domImages = [];

    videos.forEach((element) => addMedia(media, element, "video/mp4"));
    images.forEach((element) => {
      const beforeCount = media.length;
      addMedia(media, element, "image/jpeg");
      if (media.length > beforeCount) domImages.push(media[media.length - 1]);
    });

    const directVideos = media.filter((item) => item.mediaType.startsWith("video/"));
    if (directVideos.length) return directVideos.slice(0, 1);

    let embeddedMedia = getEmbeddedPostMedia(shortcode);
    if (!embeddedMedia.some((item) => item.mediaType.startsWith("video/"))) {
      const reactEmbeddedMedia = getReactEmbeddedPostMedia(shortcode);
      if (reactEmbeddedMedia.some((item) => item.mediaType.startsWith("video/"))) {
        embeddedMedia = reactEmbeddedMedia;
      }
    }
    const embeddedVideos = embeddedMedia.filter((item) => item.mediaType.startsWith("video/"));
    const activeSlideIndex = getActiveSlideIndex(mediaRoot, allMediaElements, activeMediaElements);
    const activeEmbeddedMedia = embeddedMedia[activeSlideIndex] || embeddedMedia[0];
    const activeEmbeddedVideo = activeEmbeddedMedia?.mediaType.startsWith("video/")
      ? activeEmbeddedMedia
      : embeddedVideos[0];

    // Embedded data can contain the complete current-slide video even before
    // Instagram has attached a <video> element to the viewer.
    if (activeEmbeddedMedia?.mediaType.startsWith("video/")) return [activeEmbeddedMedia];
    if (videos.length && activeEmbeddedVideo) return [activeEmbeddedVideo];

    const metadataMedia = getMetadataMedia();
    const metadataVideos = metadataMedia.filter((item) => item.mediaType.startsWith("video/"));
    if (routeIsVideo && metadataVideos.length) return [metadataVideos[0]];

    // Reels opened from a message can use a player whose source is a blob URL,
    // leaving the video element without a usable src. In that case the full
    // signed asset is still visible in the performance resource list.
    const performanceVideos = routeIsVideo
      ? getPerformanceVideoMedia()
      : [];
    if (performanceVideos.length) return [performanceVideos[0]];

    // If Instagram rendered a video player but its signed source is still
    // being resolved, never silently fall back to the poster thumbnail.
    if (!routeIsVideo && domImages.length) return domImages.slice(0, 1);

    if (!routeIsVideo && media.length) return media.slice(0, MAX_MEDIA_PER_POST);
    if (metadataVideos.length) return [metadataVideos[0]];

    if (routeIsVideo) return [];
    return activeEmbeddedMedia ? [activeEmbeddedMedia] : metadataMedia.slice(0, 1);
  }

  async function getReadyPostMedia(root, postInfo) {
    let media = [];
    const videoRoute = /reel/i.test(postInfo?.kind || "");

    // A Direct viewer often mounts the button before its video element/source.
    // Give Instagram a short window to attach the player instead of capturing
    // its poster or reporting "No media found" on the first click.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      media = getPostMedia(root, postInfo.shortcode);
      const includesVideo = media.some((item) => item.mediaType.startsWith("video/"));
      const pageHasVideo = document.querySelector("video") !== null;

      if (media.length && (includesVideo || (!videoRoute && !pageHasVideo))) return media;
      if (attempt < 9) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
      }
    }

    return media;
  }

  function setButtonState(state, message, button = mountedButton) {
    if (!button) return;

    button.dataset.igdState = state;
    button.disabled = state === "loading";
    button.title = message;
    button.setAttribute("aria-label", message);
  }

  function resetButtonAfterDelay(state, message, delay = 2200, button = mountedButton) {
    setButtonState(state, message, button);

    globalThis.setTimeout(() => {
      if (mountedButton === button) {
        setButtonState("ready", "Download post", button);
      }
    }, delay);
  }

  function getDownloadExtension(url, mediaType) {
    const normalizedType = String(mediaType || "").toLowerCase();

    if (normalizedType.startsWith("video/")) {
      if (normalizedType.includes("webm")) return "webm";
      if (normalizedType.includes("quicktime")) return "mov";
      if (normalizedType.includes("m4v")) return "m4v";
      if (normalizedType.includes("ogg")) return "ogv";
      if (normalizedType.includes("mpeg")) return "mpg";
      if (normalizedType.includes("avi")) return "avi";
      return "mp4";
    }

    if (normalizedType.startsWith("image/")) {
      if (normalizedType.includes("png")) return "png";
      if (normalizedType.includes("webp")) return "webp";
      if (normalizedType.includes("gif")) return "gif";
      return "jpg";
    }

    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const match = pathname.match(/\.([a-z0-9]{2,5})$/);
      const extension = match && match[1];

      if (["jpg", "jpeg", "png", "webp", "gif", "mp4", "webm", "mov", "m4v", "ogv", "mpg", "avi"].includes(extension)) {
        return extension === "jpeg" ? "jpg" : extension;
      }
    } catch (_error) {
      // Fall through to a media-type based default.
    }

    return normalizedType.startsWith("video/") ? "mp4" : "jpg";
  }

  function describeDownloadError(error) {
    if (typeof error === "string" && error) return error;
    if (error?.error) return String(error.error);
    if (error?.details) return String(error.details);
    return "Violentmonkey could not start the download.";
  }

  function getResponseHeader(response, name) {
    const headers = String(response?.responseHeaders || "");
    const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() || "";
  }

  function saveBlobAsFile(blob, filename) {
    const objectUrl = globalThis.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    const blobType = String(blob.type || "").toLowerCase();
    const blobExtension = blobType.startsWith("video/") || blobType.startsWith("image/")
      ? getDownloadExtension("", blobType)
      : "";
    anchor.download = blobExtension
      ? filename.replace(/\.[a-z0-9]{2,5}$/i, `.${blobExtension}`)
      : filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 60000);
  }

  function getPrivilegedRequest() {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    if (typeof globalThis.GM?.xmlHttpRequest === "function") {
      return globalThis.GM.xmlHttpRequest.bind(globalThis.GM);
    }
    return null;
  }

  function downloadVideoWithRequest(item, filename) {
    return new Promise((resolve, reject) => {
      const privilegedRequest = getPrivilegedRequest();
      if (!privilegedRequest) {
        reject(new Error("Violentmonkey's video request API is unavailable."));
        return;
      }

      try {
        privilegedRequest({
          method: "GET",
          url: item.url,
          responseType: "blob",
          timeout: 120000,
          headers: {
            Accept: "video/*, */*;q=0.8",
            Referer: globalThis.location.href,
            "Cache-Control": "no-cache"
          },
          onload: (response) => {
            const status = Number(response?.status || 0);
            if (status < 200 || status >= 300) {
              reject(new Error(`Instagram returned HTTP ${status || "an unknown error"}.`));
              return;
            }

            const blob = response?.response instanceof Blob
              ? response.response
              : new Blob([response?.response], {
                type: getResponseHeader(response, "content-type") || item.mediaType || "video/mp4"
              });
            const contentRange = getResponseHeader(response, "content-range");
            const totalBytes = Number(contentRange.match(/\/\s*([0-9]+)\s*$/)?.[1] || 0);

            // Do not save a 206 range fragment with an .mp4 extension. It is
            // the main reason a downloaded Instagram video cannot be opened.
            if (totalBytes > blob.size) {
              reject(new Error("Instagram returned only part of the video; try again after it finishes loading."));
              return;
            }

            const contentType = String(blob.type || getResponseHeader(response, "content-type") || "").toLowerCase();
            if (!blob.size || contentType.includes("text/html")) {
              reject(new Error("Instagram returned an invalid video response."));
              return;
            }

            saveBlobAsFile(blob, filename);
            resolve();
          },
          onerror: () => reject(new Error("Violentmonkey could not fetch the video.")),
          ontimeout: () => reject(new Error("The video download timed out.")),
          onabort: () => reject(new Error("The video download was cancelled."))
        });
      } catch (error) {
        reject(new Error(describeDownloadError(error)));
      }
    });
  }

  function downloadWithViolentmonkey(item, filename) {
    if (item.mediaType?.startsWith("video/") && getPrivilegedRequest()) {
      return downloadVideoWithRequest(item, filename);
    }

    return new Promise((resolve, reject) => {
      if (typeof GM_download !== "function") {
        reject(new Error("GM_download is unavailable. Check that this script is running in Violentmonkey."));
        return;
      }

      try {
        GM_download({
          url: item.url,
          name: filename,
          headers: {
            Accept: "video/*, image/*, */*;q=0.8",
            Referer: globalThis.location.href
          },
          conflictAction: "uniquify",
          saveAs: false,
          onload: resolve,
          onerror: (error) => reject(new Error(describeDownloadError(error))),
          ontimeout: () => reject(new Error("The download timed out.")),
          onabort: () => reject(new Error("The download was cancelled."))
        });
      } catch (error) {
        reject(new Error(describeDownloadError(error)));
      }
    });
  }

  async function downloadPost() {
    if (!mountedRoot || !mountedButton) return;

    const root = mountedRoot;
    const button = mountedButton;
    const postInfo = getPostInfo();
    if (!postInfo) return;

    const media = await getReadyPostMedia(root, postInfo);
    if (!media.length) {
      resetButtonAfterDelay("error", "No media found", 2200, button);
      return;
    }

    setButtonState("loading", "Downloading…", button);

    try {
      await Promise.all(media.map((item, index) => {
        const extension = getDownloadExtension(item.url, item.mediaType);
        const filename = `Instagram-${postInfo.shortcode}-${String(index + 1).padStart(2, "0")}.${extension}`;
        return downloadWithViolentmonkey(item, filename);
      }));

      if (mountedRoot !== root || mountedButton !== button) return;

      const label = media.length === 1 ? "Download started" : `${media.length} downloads started`;
      resetButtonAfterDelay("success", label, 2200, button);
    } catch (error) {
      if (mountedRoot === root && mountedButton === button) {
        resetButtonAfterDelay("error", error?.message || "Download failed", 2200, button);
      }
    }
  }
  function createDownloadButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.dataset.igdOwner = "userscript";
    button.dataset.igdState = "ready";
    button.title = "Download post";
    button.setAttribute("aria-label", "Download post");
    button.innerHTML = `
      <svg class="igd-download-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3v11m0 0 4.25-4.25M12 14 7.75 9.75M5 19.5h14" />
      </svg>
      <span class="igd-download-spinner" aria-hidden="true"></span>
    `;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      downloadPost();
    });
    return button;
  }

  function unmountButton() {
    if (mountedButton?.isConnected) mountedButton.remove();
    mountedRoot?.classList.remove(ROOT_CLASS);
    mountedRoot = null;
    mountedButton = null;
    mountedMedia = null;
    mountedPostKey = "";
  }

  function syncButton() {
    const postInfo = getPostInfo();
    if (!postInfo) {
      unmountButton();
      return;
    }

    const postKey = `${postInfo.kind}:${postInfo.shortcode}`;
    if (mountedRoot?.isConnected && mountedButton?.isConnected && mountedPostKey === postKey) {
      const candidate = findButtonAnchorMedia(mountedRoot);
      if (candidate && (!mountedMedia || isSameMediaCluster(candidate, mountedMedia))) {
        mountedMedia = candidate;
      }
      positionButton();
      return;
    }

    const root = findPostRoot();
    if (!root) {
      unmountButton();
      return;
    }

    // Let an already-installed copy of the companion extension own the
    // button rather than rendering a duplicate while users switch formats.
    const existingButton = [...document.querySelectorAll(`.${BUTTON_CLASS}`)].find((button) =>
      button !== mountedButton && button.dataset.igdOwner !== "userscript"
    );
    if (existingButton && existingButton !== mountedButton) {
      unmountButton();
      return;
    }

    if (root === mountedRoot && mountedButton?.isConnected) return;

    unmountButton();
    root.classList.add(ROOT_CLASS);
    mountedRoot = root;
    mountedMedia = findButtonAnchorMedia(root);
    mountedPostKey = postKey;
    mountedButton = createDownloadButton();
    // Portal the control to body so a transformed/overflow-hidden Instagram
    // viewer or a scrolling Direct pane cannot clip a fixed-position button.
    (document.body || document.documentElement).appendChild(mountedButton);
    positionButton();
  }

  function scheduleSync() {
    if (syncTimer) globalThis.clearTimeout(syncTimer);

    syncTimer = globalThis.setTimeout(() => {
      syncTimer = null;
      syncButton();
    }, 200);
  }

  function watchNavigation() {
    ["pushState", "replaceState"].forEach((method) => {
      const original = globalThis.history[method];

      globalThis.history[method] = function (...args) {
        const result = original.apply(this, args);
        scheduleSync();
        return result;
      };
    });

    globalThis.addEventListener("popstate", scheduleSync);
    globalThis.addEventListener("hashchange", scheduleSync);
    globalThis.addEventListener("scroll", () => {
      if (mountedButton?.isConnected) {
        positionButton();
      } else {
        scheduleSync();
      }
    }, { capture: true, passive: true });
    globalThis.addEventListener("resize", () => {
      if (mountedButton?.isConnected) {
        positionButton();
      } else {
        scheduleSync();
      }
    }, { passive: true });
  }

  function start() {
    installDownloaderStyles();
    watchNavigation();
    mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["href", "poster", "src", "srcset"],
      childList: true,
      subtree: true
    });
    scheduleSync();
  }

  start();
})();


// Ported from the Instagram liked-posts userscript. It is intentionally
// isolated from the downloader so the direct-post button remains restricted
// to explicit /p/, /reel/, and /reels/ URLs.
(() => {
  'use strict';

  const SCRIPT_VERSION = '3.2.0-extension';
  console.log(`[Instagram liked-post links v${SCRIPT_VERSION}] loaded`);

  function unwrapPageObject(value) {
    // Firefox content scripts may expose page-owned objects through an Xray
    // wrapper. Chromium content scripts simply return the original object.
    try {
      return value?.wrappedJSObject || value;
    } catch (_error) {
      return value;
    }
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
