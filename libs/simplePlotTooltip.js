/* 
* simplePlotTooltip.js
* A simpler, dot-driven HTML tooltip helper for Observable Plot, when its title channel is 
* not enough and/or responsive enough.
* Always add an invisible dot layer to any chart, if dot isn't already a part of it, since 
* this helper targets the dots via a selector for tooltip tracking to keep the code simple.
* A more complex version of the tooltip script, htmlTooltip.js, is also available , but there's a chance
* you need to take on more scale plumbing and mark-specific quirks, since there's no universial solution.
* The helper recalculates dot positions on:
    (a) pointer enter (freshness)
    (b) window resize
    (c) window scroll
* For very large datasets, consider:
    (a) Smaller hitRadius
    (b) Throttling pointermove further
    (c) Reducing dot count (sample) or using Plot’s native title channel when sufficient
* Main function: attachSimpleTooltip. More details comments in the function.
* Example setup:
    import { attachSimpleTooltip } from "./simplePlotTooltip.js";
    // If the chart creation function is in a different script module, specify 
    window.attachSimpleTooltip = attachSimpleTooltip;
* Example usage:
    // Set up a global varible to hold cleanup for current chart’s tooltip
    let detachTooltip; 
    // After the chart is defined with plot.plot(...), detach previous tooltip to prevent leaks
    if (detachTooltip) { detachTooltip(); detachTooltip = undefined; }
    // Replace the chart
    document.getElementById("chart").replaceChildren(chart);
    // Attach the tooltip to the new chart
    const detach = attachSimpleTooltip(chart, data, { x: d => d.name, y: d => d.value, text: ... });
 * Authoring pattern for reliability
    (a) Always add the invisible dot layer in your chart:
        Plot.dot(data, { x: ..., y: ..., r: 6, opacity: 0, ariaLabel: "dot" })
    (b) Keep the dot layer’s data order aligned with the tooltip data array you pass to the helper.
    (c) If you transform or aggregate for the visible mark (e.g., binning/grouping for bars), 
        feed the same transformed array to both the dot layer and the tooltip.
    (d) If there are multiple series, create one dot layer per series and merge arrays if you want a single tooltip, 
        or attach multiple helpers with different selectors.
 * Workflow: 
    (a) The simplePlotTooltip.js module stays in default or specified folder.
    (b) Build the chart with Plot.plot(...), if not included, add a hidden dot layer with opacity: 0 and ariaLabel: "dot".
    (c) Attach the tooltip by calling attachSimpleTooltip(chart, data, { ... }).
    Since everything is scoped inside <script type="module">, it's clean and safe for future extensions.
    If you want access to attachSimpleTooltip globally (e.g., from DevTools), you can optionally add:
    window.attachSimpleTooltip = attachSimpleTooltip;
 * Final notes on the design:
    (a) Intentionally avoid reading plot scales or mark internals. 
        Otherwise resolving for the right SVG (i.e., resolvePlotSVG function) would be much more complex.
    (b) Rely purely on the presence and order of the dot elements (invisible or not).
    These keep the helper function small and predictable across chart types. 
    (c) Perfer to keep the tooltip design internal to the module. If CSS is preferred:
            .plot-tooltip { ...add customizations here if needed... }
*/

function resolvePlotSVG(root) {
  // root is typically the Figure returned by Plot.plot(...).
  // We want the main chart SVG, not the legend’s SVG.
  if (!root) return null;

  // If root is an SVG that contains dot marks, use it.
  if (root instanceof SVGSVGElement) {
    if (root.querySelector("g[aria-label='dot']")) return root;
  }

  // Otherwise, search descendant SVGs and prefer one with dots.
  const svgs = root.querySelectorAll?.("svg");
  if (svgs && svgs.length) {
    for (const s of svgs) {
      if (s.querySelector("g[aria-label='dot']")) return s;
    }
    // Fallback to first SVG if no explicit dot group found.
    return svgs[0];
  }

  return root instanceof SVGSVGElement ? root : null;
}

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
  // Fallback text if no text/html provided.
  if (d == null) return "";
  if (typeof d === "object") {
    try { return JSON.stringify(d); } catch { /* ignore */ }
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
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2
    };
  });
}

export function attachSimpleTooltip(root, data, {
  // Accessors can be used in your text/html, but we don’t use them to hit-test.
  x, //Accessor for x value (e.g., d => d.date)
  y, //Accessor for y value (e.g., d => d.sales)
  text, // optional: (d, i) => string (safe, recommended)
  html, // optional: (d, i) => string (only if allowHTML = true)
  allowHTML = false, // default safer; set true to use `html` output literally

  // Interaction + look
  hitRadius = 16, // Hover radius in pixels for detection
  className = "plot-tooltip", // Tooltip class name to support CSS
  clampPadding = 8, // viewport padding when clamping tooltip to screen edges

  // Which elements to bind to. Defaults to invisible Plot.dot circles.
  dotSelector = "g[aria-label='dot'] circle, g[aria-label='dot'] [r]",

  // Event target; defaults to the figure (root) when possible.
  container: userContainer
} = {}) {
  if (!Array.isArray(data)) throw new Error("attachSimpleTooltip: `data` must be an array.");
  // text/html fallback
  if (!text && !html) text = defaultText;
  
  // Find the dot marks' SVG element (Figure is the chart's DIV element and legend is also a SVG, need to search through) 
  const svg = resolvePlotSVG(root);
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error("attachSimpleTooltip: could not find the Plot SVG. Ensure a chart is mounted.");
  }

  const container = userContainer || (root instanceof Element ? root : svg);

  // Find the dots we plan to use for hit-testing.
  let dotEls = svg.querySelectorAll(dotSelector);
  if (!dotEls || dotEls.length === 0) {
    throw new Error("attachSimpleTooltip: no dot elements found. Add an invisible Plot.dot layer or adjust `dotSelector`.");
  }

  // Align element count with data length conservatively.
  // This assumes the dot layer matches the tooltip data order.
  if (dotEls.length !== data.length) {
    console.warn(`attachSimpleTooltip: found ${dotEls.length} dot elements vs data.length ${data.length}. Aligning by index up to min length.`);
    const n = Math.min(dotEls.length, data.length);
    dotEls = Array.from(dotEls).slice(0, n);
    data = data.slice(0, n);
  }

  // Create the tooltip element once.
  const tip = createTooltipElement(className);

  // Precompute centers and use event listeners to refresh on entry, resize, and scroll for correctness.
  let centers = computeDotCentersClient(dotEls);

  const recalc = () => {
    centers = computeDotCentersClient(dotEls);
  };

  const onResize = () => recalc();
  const onScroll = () => recalc();

  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });

  let raf = 0;
  let pointerInside = false;

  // This is a function that picks what to show in the tooltip:
  // If allowHTML is true and an html function is provided through the call, it injects that HTML directly.
  // If an html function is provided but function flag didn’t allow html, 
  // it escapes the special characters to avoid accidental injection and then inserts it.
  // Otherwise, it uses the text function if provided, or a default string conversion (defaultText function call)
  // This lets you opt into html version safely, without risking untrusted content.
  const renderContent = (d, i) => {
    if (allowHTML && typeof html === "function") {
      tip.innerHTML = html(d, i);
      return;
    }
    if (typeof html === "function") {
      // Escape minimal set to avoid accidental HTML injection if allowHTML=false.
      const esc = String(html(d, i))
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      tip.innerHTML = esc;
      return;
    }
    tip.textContent = typeof text === "function" ? text(d, i) : defaultText(d, i);
  };

  // This function tracks mouse pointer moves over the chart container:
  // Use requestAnimationFrame (via raf), which ensures  the animation updates are synchronized 
  // with the browser's refresh rate, so work runs at most once per frame, keeping interactions smooth.
  // The call back function finds the closest invisible dot to the pointer:
  // centers is an array of dot centers on screen, calculated through the computeDotCentersClient function
  // For each center, it computes distance squared to the pointer and keeps the closest one within hitRadius.
  // Then if a nearby dot exists: (bestI >= 0)
  // It renders content for that point.
  // It makes the tooltip visible and positions it near the pointer (clientX/Y + 12 pixels offset).
  // Calls the clamps function with the tooltip so it stays inside the viewport (no cutoff at the edges).
  // If no dot is close and the pointer is inside, it hides the tooltip.
  // This allows any dot within the radius to trigger the tooltip display.
  const move = (e) => {
    const { clientX, clientY } = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;

      // Find nearest dot within hitRadius.
      let bestI = -1;
      let bestD2 = hitRadius * hitRadius;

      for (let i = 0; i < centers.length; i++) {
        const c = centers[i];
        const dx = c.x - clientX;
        const dy = c.y - clientY;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
          bestD2 = d2;
          bestI = i;
        }
      }

      if (bestI >= 0) {
        const d = data[bestI];
        renderContent(d, bestI);

        // Position near the pointer; clamp to viewport.
        let left = clientX + 12;
        let top = clientY + 12;

        // First set visible to measure size accurately.
        tip.style.visibility = "visible";
        const tipRect = tip.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;

        left = clamp(left, clampPadding, vw - tipRect.width - clampPadding);
        top = clamp(top, clampPadding, vh - tipRect.height - clampPadding);

        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
      } else if (pointerInside) {
        tip.style.visibility = "hidden";
      }
    });
  };

  // container listener function. It recomputes dot centers (recalc) 
  // in case the page scrolled or resized since last time.
  const enter = () => {
    pointerInside = true;
    recalc(); // In case layout shifted since last interaction.
  };

  // Hides the tooltip when outside of the container to prevent ghosts when the pointer exits
  const leave = () => {
    pointerInside = false;
    tip.style.visibility = "hidden";
  };

  container.addEventListener("pointerenter", enter); // pointerenter: start tracking and recalc centers.
  container.addEventListener("pointermove", move); // pointermove: evaluate and show/hide the tooltip per frame.
  container.addEventListener("pointerleave", leave); // pointerleave: stop tracking and hide.
  // Touchstart marks intent and tooltip then follows with pointermove as user drags. Added mainly for touch pad usage.
  container.addEventListener("touchstart", enter, { passive: true }); // touchstart: treat a tap like entering so mobile users get tooltips.

  // Detach/cleanup function for Single Page Application (SPA) navigation or re-renders.
  // Removes all listeners. 
  // Removes window resize/scroll listeners. 
  // Cancels a pending animation frame if any.
  // Removes the tooltip element from the DOM.
  // This is called before inserting the chart into the DOM to prevents memory leaks 
  // and keeps the app clean when re-render or navigate away.
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



