/*!
 * simplePlotTooltip.umd.js
 * A simpler, dot-driven HTML tooltip helper for Observable Plot, when its title channel is 
 * not enough and/or responsive enough.
 * Always add an invisible dot layer to any chart, if dot isn't already a part of it,
 * since the tooltip tracks the dots to keep the code simple. A more complex version
 * of the tooltip script, htmlTooltip.js, is also available , but there's a chance
 * you need to take on more scale plumbing and mark-specific quirks, since there's 
 * no universial solution.
 * The ES Module version contains more detailed comments for the step-by-step.
 * Workflow: Store the detach function and call it on route changes/unmounts.
 * The helper recalculates dot positions on:
    (a) pointer enter (freshness)
    (b) window resize
    (c) window scroll
* For very large datasets, consider:
    (a) Smaller hitRadius
    (b) Throttling pointermove further
    (c) Reducing dot count (sample) or using Plot’s native title channel when sufficient
 * The function exposes: window.SimplePlotTooltip.attachSimpleTooltip
 * Example setup:
    <div id="chart"></div>
    <script src="path/to/plot.umd.js"></script>
    <script src="src/simplePlotTooltip.umd.js"></script>
    <script>
 * Example usage:
    // Build chart using Plot global, then:
    var detach = SimplePlotTooltip.attachSimpleTooltip(chart, data, {
        text: function(d){ return d.name + ": " + d.value; }
    });
    </script>
 * Don’t need to assign it to window, the script already puts it on window.SimplePlotTooltip globally  
 * Authoring pattern for reliability
    (a) Always add the invisible dot layer in your chart:
        Plot.dot(data, { x: ..., y: ..., r: 6, opacity: 0, ariaLabel: "dot" })
    (b) Keep the dot layer’s data order aligned with the tooltip data array you pass to the helper.
    (c) If you transform or aggregate for the visible mark (e.g., binning/grouping for bars), 
        feed the same transformed array to both the dot layer and the tooltip.
    (d) If there are multiple series, create one dot layer per series and merge arrays if you want a single tooltip, 
        or attach multiple helpers with different selectors.
 */

// Checks for compatibility with multiple environments: AMD, CommonJS, and browser globals per standard UMD 
// (Universal Module Definition) design pattern.
// Immediately Invoked Function Expression (IIFE), run as soon as it's defined. 
// root: the global object (window in browsers, global in Node.js).
// factory: a function that returns the module’s API (NOTE: captial S in SimplePlotTooltip)
// (a) AMD: Checks if define is available and supports AMD, 
// If it does, define([], factory) registers the module with no dependencies.
// (b) Common JS: Checks if module.exports exists—typical in CommonJS (Node.js-style) or bundlers like Browserify.
// If it does, exports the module using module.exports
// (c) If neither AMD nor CommonJS is detected, it assumes a Browser global environment.
// In this case, attach the module to the global object (window or self) as SimplePlotTooltip.
// (d) Ensures compatibility across environments by Using "self" in web workers and modern browsers,
//  or "this" in older environments or Node.js..

(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimplePlotTooltip = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict"; // Enforces stricter parsing and error handling

  // root is typically the "Figure" returned by Plot.plot(...).
  // We want the main chart SVG, not the legend’s SVG.
  function resolvePlotSVG(root) {
    if (!root) return null;
    if (root instanceof SVGSVGElement) {
      if (root.querySelector("g[aria-label='dot']")) return root;
    }
    const svgs = root.querySelectorAll?.("svg");
    if (svgs && svgs.length) {
      for (const s of svgs) {
        if (s.querySelector("g[aria-label='dot']")) return s;
      }
      return svgs[0];
    }
    return root instanceof SVGSVGElement ? root : null;
  }

  // Define style of the tooltip
  function createTooltipElement(className) {
    const tip = document.createElement("div");
    tip.className = className;
    Object.assign(tip.style, {
      position: "fixed",
      pointerEvents: "none",
      background: "rgba(20,20,30,0.92)",
      color: "#fff",
      padding: "6px 10px",
      borderRadius: "6px",
      font: "12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
      transform: "translate3d(0,0,0)",
      visibility: "hidden",
      zIndex: "2147483647",
      maxWidth: "320px",
      whiteSpace: "nowrap"
    });
    document.body.appendChild(tip);
    return tip;
  }

  function defaultText(d, i) {
    if (d == null) return "";
    if (typeof d === "object") {
      try { return JSON.stringify(d); } catch {}
    }
    return String(d);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(n, hi));
  }

  // Recompute the client-center for each dot element.
  function computeDotCentersClient(els) {
    return Array.from(els, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  }

  function attachSimpleTooltip(root, data, options) {
    options = options || {};
    var x = options.x;
    var y = options.y;
    var text = options.text;
    var html = options.html;
    var allowHTML = options.allowHTML === true;

    var hitRadius = options.hitRadius == null ? 16 : options.hitRadius;
    var className = options.className || "plot-tooltip";
    var clampPadding = options.clampPadding == null ? 8 : options.clampPadding;

    var dotSelector = options.dotSelector || "g[aria-label='dot'] circle, g[aria-label='dot'] [r]";
    var userContainer = options.container;

    if (!Array.isArray(data)) throw new Error("attachSimpleTooltip: `data` must be an array.");
    if (!text && !html) text = defaultText;

    var svg = resolvePlotSVG(root);
    if (!(svg instanceof SVGSVGElement)) {
      throw new Error("attachSimpleTooltip: could not find the Plot SVG. Ensure a chart is mounted.");
    }

    var container = userContainer || (root instanceof Element ? root : svg);

    var dotEls = svg.querySelectorAll(dotSelector);
    if (!dotEls || dotEls.length === 0) {
      throw new Error("attachSimpleTooltip: no dot elements found. Add an invisible Plot.dot layer or adjust `dotSelector`.");
    }

    if (dotEls.length !== data.length) {
      console.warn("attachSimpleTooltip: found " + dotEls.length + " dot elements vs data.length " + data.length + ". Aligning by index up to min length.");
      var n = Math.min(dotEls.length, data.length);
      dotEls = Array.from(dotEls).slice(0, n);
      data = data.slice(0, n);
    }

    var tip = createTooltipElement(className);
    var centers = computeDotCentersClient(dotEls);

    var recalc = function () {
      centers = computeDotCentersClient(dotEls);
    };

    var onResize = function () { recalc(); };
    var onScroll = function () { recalc(); };

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    var raf = 0;
    var pointerInside = false;

    function renderContent(d, i) {
      if (allowHTML && typeof html === "function") {
        tip.innerHTML = html(d, i);
        return;
      }
      if (typeof html === "function") {
        var esc = String(html(d, i))
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        tip.innerHTML = esc;
        return;
      }
      tip.textContent = typeof text === "function" ? text(d, i) : defaultText(d, i);
    }

    var move = function (e) {
      var clientX = e.clientX, clientY = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;

        var bestI = -1;
        var bestD2 = hitRadius * hitRadius;

        for (var i = 0; i < centers.length; i++) {
          var c = centers[i];
          var dx = c.x - clientX;
          var dy = c.y - clientY;
          var d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) {
            bestD2 = d2;
            bestI = i;
          }
        }

        if (bestI >= 0) {
          var d = data[bestI];
          renderContent(d, bestI);

          var left = clientX + 12;
          var top = clientY + 12;

          tip.style.visibility = "visible";
          var tipRect = tip.getBoundingClientRect();
          var vw = document.documentElement.clientWidth;
          var vh = document.documentElement.clientHeight;

          left = clamp(left, clampPadding, vw - tipRect.width - clampPadding);
          top = clamp(top, clampPadding, vh - tipRect.height - clampPadding);

          tip.style.left = left + "px";
          tip.style.top = top + "px";
        } else if (pointerInside) {
          tip.style.visibility = "hidden";
        }
      });
    };

    var enter = function () { pointerInside = true; recalc(); };
    var leave = function () { pointerInside = false; tip.style.visibility = "hidden"; };

    container.addEventListener("pointerenter", enter);
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerleave", leave);
    container.addEventListener("touchstart", enter, { passive: true });

    return function detach() {
      container.removeEventListener("pointerenter", enter);
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", leave);
      container.removeEventListener("touchstart", enter);

      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);

      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      tip.remove();
    };
  }

  return { attachSimpleTooltip: attachSimpleTooltip };
}));
