(function () {
  "use strict";

  var ARTICLE_SELECTOR = "article .article-body";
  var SEARCH_URL = "/articles/search/";
  var MAX_SELECTION_LENGTH = 80;
  var MIN_MEANINGFUL_CHARACTERS = 2;
  var BLOCKED_SELECTOR = "input, textarea, button, select, pre, code, script, style";
  var COARSE_POINTER_QUERY = "(pointer: coarse)";

  function normalizeSelectionText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function countMeaningfulCharacters(value) {
    try {
      return (value.match(new RegExp("[\\p{L}\\p{N}]", "gu")) || []).length;
    } catch (error) {
      return (value.match(/[A-Za-z0-9\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    }
  }

  function elementFromNode(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function nodeIsInside(container, node) {
    var element = elementFromNode(node);
    return Boolean(element && container.contains(element));
  }

  function rangeTouchesBlockedElement(range, article) {
    var startElement = elementFromNode(range.startContainer);
    var endElement = elementFromNode(range.endContainer);

    if (
      (startElement && startElement.closest(BLOCKED_SELECTOR)) ||
      (endElement && endElement.closest(BLOCKED_SELECTOR))
    ) {
      return true;
    }

    var blockedElements = article.querySelectorAll(BLOCKED_SELECTOR);
    for (var index = 0; index < blockedElements.length; index += 1) {
      try {
        if (range.intersectsNode(blockedElements[index])) return true;
      } catch (error) {
        return true;
      }
    }

    return false;
  }

  function getValidSelection(article) {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;

    var range = selection.getRangeAt(0);
    var commonAncestor = elementFromNode(range.commonAncestorContainer);
    if (
      !commonAncestor ||
      !article.contains(commonAncestor) ||
      !nodeIsInside(article, selection.anchorNode) ||
      !nodeIsInside(article, selection.focusNode) ||
      rangeTouchesBlockedElement(range, article)
    ) {
      return null;
    }

    var text = normalizeSelectionText(selection.toString());
    var length = Array.from(text).length;
    if (
      !text ||
      length > MAX_SELECTION_LENGTH ||
      countMeaningfulCharacters(text) < MIN_MEANINGFUL_CHARACTERS
    ) {
      return null;
    }

    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;

    return { text: text, rect: rect };
  }

  function initSelectionSearch() {
    var article = document.querySelector(ARTICLE_SELECTOR);
    if (!article) return;

    var coarsePointerQuery = window.matchMedia
      ? window.matchMedia(COARSE_POINTER_QUERY)
      : null;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "selection-search-button";
    button.setAttribute("aria-label", "搜索所选文字");
    button.textContent = "搜索";
    button.hidden = true;
    document.body.appendChild(button);

    var savedSelectionText = "";
    var showTimer = 0;
    var buttonInteraction = false;
    var navigationStarted = false;

    function hideButton() {
      window.clearTimeout(showTimer);
      savedSelectionText = "";
      buttonInteraction = false;
      button.classList.remove("is-visible");
      button.hidden = true;
    }

    function positionButton(selectionData) {
      var viewportPadding = 8;
      var selectionGap = 10;

      button.hidden = false;
      button.style.visibility = "hidden";
      button.classList.remove("is-visible");

      var buttonWidth = button.offsetWidth;
      var buttonHeight = button.offsetHeight;
      var left = selectionData.rect.left + (selectionData.rect.width - buttonWidth) / 2;
      var aboveTop = selectionData.rect.top - buttonHeight - selectionGap;
      var belowTop = selectionData.rect.bottom + selectionGap;
      var preferBelow = Boolean(coarsePointerQuery && coarsePointerQuery.matches);
      var top = preferBelow ? belowTop : aboveTop;

      left = Math.max(
        viewportPadding,
        Math.min(left, window.innerWidth - buttonWidth - viewportPadding)
      );

      if (preferBelow && top + buttonHeight > window.innerHeight - viewportPadding) {
        top = aboveTop;
      } else if (!preferBelow && top < viewportPadding) {
        top = belowTop;
      }

      top = Math.max(
        viewportPadding,
        Math.min(top, window.innerHeight - buttonHeight - viewportPadding)
      );

      button.style.left = Math.round(left) + "px";
      button.style.top = Math.round(top) + "px";
      button.style.visibility = "";

      window.requestAnimationFrame(function () {
        if (!button.hidden) button.classList.add("is-visible");
      });
    }

    function showForCurrentSelection() {
      var selectionData = getValidSelection(article);
      if (!selectionData) {
        hideButton();
        return;
      }

      savedSelectionText = selectionData.text;
      positionButton(selectionData);
    }

    function scheduleShow(delay) {
      window.clearTimeout(showTimer);
      showTimer = window.setTimeout(showForCurrentSelection, delay);
    }

    function openSearch(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (navigationStarted) return;

      var query = savedSelectionText;
      if (!query) {
        hideButton();
        return;
      }

      navigationStarted = true;
      window.location.href = SEARCH_URL + "?q=" + encodeURIComponent(query);
    }

    article.addEventListener("mouseup", function (event) {
      if (button.contains(event.target)) return;
      scheduleShow(0);
    });

    article.addEventListener("touchend", function (event) {
      if (button.contains(event.target)) return;
      scheduleShow(160);
    }, { passive: true });

    button.addEventListener("pointerdown", function (event) {
      buttonInteraction = true;
      event.stopPropagation();
      if (event.pointerType === "mouse") event.preventDefault();
    });

    button.addEventListener("mousedown", function (event) {
      buttonInteraction = true;
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener("touchstart", function (event) {
      buttonInteraction = true;
      event.stopPropagation();
    }, { passive: true });

    button.addEventListener("touchend", openSearch, { passive: false });
    button.addEventListener("click", openSearch);

    function hideFromOutsideInteraction(event) {
      if (!button.contains(event.target)) hideButton();
    }

    if (window.PointerEvent) {
      document.addEventListener("pointerdown", hideFromOutsideInteraction);
    } else {
      document.addEventListener("mousedown", hideFromOutsideInteraction);
      document.addEventListener("touchstart", hideFromOutsideInteraction, { passive: true });
    }

    document.addEventListener("selectionchange", function () {
      if (buttonInteraction || navigationStarted) return;

      var selection = window.getSelection ? window.getSelection() : null;
      if (!selection || selection.isCollapsed) {
        hideButton();
        return;
      }

      scheduleShow(140);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") hideButton();
    });

    window.addEventListener("scroll", hideButton, { passive: true });
    window.addEventListener("resize", hideButton);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSelectionSearch);
  } else {
    initSelectionSearch();
  }
})();
