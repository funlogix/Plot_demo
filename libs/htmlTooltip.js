// htmlTooltip.js
//
// A more complex way to support tooltip for Observable Plot charts (or any SVG with x/y scales on svg.scale).
// - Safe by default: uses text content unless allowHTML is explicitly true.
// - Responsive: activates within a configurable pixel radius around the nearest datum.
// - Reliable across transforms: uses getScreenCTM to convert pointer -> SVG coordinates.
// - Clean lifecycle: returns a detach() that removes listeners, cancels RAF, releases capture.
//
// Usage:
//   import { attachHTMLTooltip } from './htmlTooltip.js';
//   const detach = attachHTMLTooltip(chartSVG, data, {
//     x: d => d.date,
//     y: d => d.sales,
//     text: (d) => `${fmt(d.date)} • ${d.product}: $${d.sales.toFixed(2)}`, // safe default
//     // or html: (d) => `<strong>${...}</strong>`, allowHTML: true
//     hitRadius: 18
//   });
//
// Note: Use simplePlotTooltip if possible (requires a dot mark layer to bind to the tooltip)


// Find the main plot SVG (not the legend). Prefer an SVG that contains marks.
function resolvePlotSVG(root) {
  if (!root) return null;

  // Case 1: Already an SVG that looks like the main plot (has marks).
  if (root instanceof SVGSVGElement) {
    if (root.querySelector("[aria-label='dot'], [aria-label='line'], [aria-label='bar']")) return root;
    // keep as candidate while we search children
  }

  // Case 2: Search descendants; prefer SVGs with mark groups.
  if (root instanceof Element) {
    const svgs = root.querySelectorAll("svg");
    // Prefer an SVG that has marks (dot/line/bar)
    for (const s of svgs) {
      if (s.querySelector("[aria-label='dot'], [aria-label='line'], [aria-label='bar']")) return s;
    }
    // Next best: an SVG that exposes a scale object/function
    for (const s of svgs) {
      if (s.scale) return s;
    }
    // Fallback: just return the first SVG if any
    if (svgs.length > 0) return svgs[0];
  }

  // If root is an SVG with no marks but this is all we have, return it.
  return root instanceof SVGSVGElement ? root : null;
}

// Normalize Plot scale access across forms:
// - owner.scale is a function: owner.scale("x") -> fn/object
// - owner.scale is an object with x/y
// Wrap returned object if it has .apply or .scale methods.
function getXYScales(owner) {
  const s = owner?.scale;
  if (!s) return { xScale: null, yScale: null };

  const wrap = (w) => {
    if (!w) return null;
    if (typeof w === "function") return w;
    if (typeof w.apply === "function") return (v) => w.apply(v);
    if (typeof w.scale === "function") return (v) => w.scale(v);
    return null;
  };

  // If scale is a getter function, ask for "x"/"y".
  if (typeof s === "function") {
    const xs = wrap(s("x"));
    const ys = wrap(s("y"));
    return { xScale: xs, yScale: ys };
  }

  // Otherwise, treat scale as an object with x/y
  return { xScale: wrap(s.x), yScale: wrap(s.y) };
}

export function attachHTMLTooltip(root, data, {
  x,
  y,
  text,                        // optional: (d, i) => string (safe, recommended)
  html,                        // optional: (d, i) => string (only if allowHTML = true)
  allowHTML = false,           // default safer; set true to use `html` output literally
  hitRadius = 16,              // Hover radius in pixels for detection
  container: userContainer,    // Event target; defaults to the figure (root) when possible.
  capture = true,              // use Pointer Capture to improve drag/touch interactions
  clampPadding = 8,            // viewport padding when clamping tooltip to screen edges
  className = "plot-tooltip",  // Tooltip class name to support CSS
  // For DOM fallback: selector for point elements to read screen positions from.
  elementsSelector = "g[aria-label='dot'] circle"
} = {}) {
  if (!Array.isArray(data)) throw new Error("attachHTMLTooltip: `data` must be an array.");
  if (typeof x !== "function" || typeof y !== "function") {
    throw new Error("attachHTMLTooltip: accessors `x` and `y` must be functions.");
  }
  if (!text && !html) text = (d) => String(d);

  // Resolve the main plot SVG (handles figure/wrapper + legend)
  const svg = resolvePlotSVG(root);
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error("attachHTMLTooltip: could not find the Plot SVG. Pass the figure/SVG from plot.plot(...) or a wrapper that contains it.");
  }

  // Choose the event container (wrapper/figure preferred if provided)
  const container = userContainer || (root instanceof Element ? root : svg);

  // Try to get scales from either the wrapper (root) or the svg.
  let { xScale, yScale } = getXYScales(root);
  if (!xScale || !yScale) ({ xScale, yScale } = getXYScales(svg));

  // Tooltip element (position: fixed to avoid scroll math)
  const tip = document.createElement("div");
  tip.className = className;
  Object.assign(tip.style, {
    position: "fixed",
    pointerEvents: "none",
    background: "rgba(20,20,30,0.9)",
    color: "white",
    padding: "6px 10px",
    borderRadius: "6px",
    font: "12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    transform: "translate3d(0,0,0)",
    visibility: "hidden",
    zIndex: "9999",
    maxWidth: "320px",
    whiteSpace: "nowrap"
  });
  document.body.appendChild(tip);

  // Basic html escaping utility function to prevent injection if allowHTML=false.
  const escapeHTML = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
             .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
             .replace(/'/g, "&#39;");

  // Convert a viewport pointer coordinate (clientX/clientY) to SVG coordinates (for scale-mode hit testing).
  //    This handles viewBox, CSS transforms, zooming, etc.
  function clientToSvgXY(clientX, clientY) {
    const ctm = svg.getScreenCTM?.();
    if (ctm && typeof ctm.inverse === "function") {
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }
    // Fallback: use bounding client rect if CTM is unavailable (rare).
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // Decide mode: scale-based if we have x/y scales; else DOM-based using dots
  let mode = (xScale && yScale) ? "scale" : "dom";

  // Precompute point positions
  let pointsSVG = null;     // [{x, y}] in SVG coords (scale mode)
  let pointsScreen = null;  // [{x, y}] in client coords (DOM fallback)

  if (mode === "scale") {
    pointsSVG = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      let xv, yv;
      try { xv = x(data[i]); yv = y(data[i]); } catch { continue; }
      const sx = xScale(xv);
      const sy = yScale(yv);
      pointsSVG[i] = (Number.isFinite(sx) && Number.isFinite(sy)) ? { x: sx, y: sy } : null;
    }
  } else {
    // DOM fallback: collect rendered dot centers in screen coords
    const els = svg.querySelectorAll(elementsSelector);
    if (!els || els.length === 0) {
      // Try a couple of alternate selectors commonly used by Plot
      const alt = svg.querySelectorAll("g[aria-label='dot'] [r], g[aria-label='dot'] circle, g[aria-label='dot'] path");
      const list = alt && alt.length ? alt : els;
      if (!list || list.length === 0) {
        throw new Error("attachHTMLTooltip: scales not found and no point elements matched. Provide a custom `elementsSelector` or ensure a dot mark exists.");
      }
      pointsScreen = Array.from(list, el => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    } else {
      pointsScreen = Array.from(els, el => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    }

    if (pointsScreen.length !== data.length) {
      // Warn, but proceed with the min length to avoid out-of-bounds.
      console.warn(`attachHTMLTooltip: matched ${pointsScreen.length} point elements vs data.length ${data.length}. Aligning by index up to min length.`);
      const n = Math.min(pointsScreen.length, data.length);
      pointsScreen.length = n;
      data = data.slice(0, n);
    }
  }

  // State for throttling and lifecycle.
  let raf = 0;
  let pointerInside = false;
  let capturedId = null;

  // The core pointer move handler (throttled via RAF).
  const move = (e) => {
    // Grab needed event fields now, because some frameworks pool events.
    const { clientX, clientY, pointerId } = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;

      // Convert pointer to SVG coords so we can compare to scaled data points.
      let px, py;
      if (mode === "scale") {
        const p = clientToSvgXY(clientX, clientY);
        px = p.x; py = p.y;
      } else {
        px = clientX; py = clientY;
      }

      // Find nearest neighbor within hitRadius (squared distance for speed).
      let bestI = -1;
      let bestD2 = hitRadius * hitRadius;

      if (mode === "scale") {
        for (let i = 0; i < (pointsSVG?.length || 0); i++) {
          const p = pointsSVG[i];
          if (!p) continue;
          const dx = p.x - px;
          const dy = p.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) { bestD2 = d2; bestI = i; }
        }
      } else {
        for (let i = 0; i < (pointsScreen?.length || 0); i++) {
          const p = pointsScreen[i];
          if (!p) continue;
          const dx = p.x - px;
          const dy = p.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) { bestD2 = d2; bestI = i; }
        }
      }
      // Nearby point found — build the tooltip content safely.
      if (bestI >= 0) {
        const d = data[bestI];

        if (allowHTML && typeof html === "function") {
          tip.innerHTML = html(d, bestI);
        } else if (typeof text === "function") {
          tip.textContent = text(d, bestI);
        } else if (typeof html === "function") { //// HTML provided but allowHTML=false => escape as text for safety.
          tip.innerHTML = escapeHTML(html(d, bestI));
        } else {
          tip.textContent = String(d);
        }

        // Position near pointer in viewport coords (page coords are scroll-safe).
        let left = clientX + 12;
        let top  = clientY + 12;

        // Clamp tooltip inside viewport.
        // Measure after content set so width/height are correct.
        const tipRect = tip.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;

        left = Math.max(clampPadding, Math.min(left, vw - tipRect.width - clampPadding));
        top  = Math.max(clampPadding, Math.min(top,  vh - tipRect.height - clampPadding));

        tip.style.left = `${left}px`;
        tip.style.top  = `${top}px`;
        tip.style.visibility = "visible";

        // Pointer capture for reliable move/up events (especially for touch/pen).
        if (capture && typeof pointerId === "number") {
          try {
            if (!container.hasPointerCapture?.(pointerId)) {
              container.setPointerCapture?.(pointerId);
              capturedId = pointerId;
            }
          } catch { /* ignore */ }
        }
      } else if (pointerInside) {
        // No nearby point — hide tooltip and release capture if held it.
        tip.style.visibility = "hidden";
        if (capture && typeof pointerId === "number" && capturedId === pointerId) {
          try {
            if (container.hasPointerCapture?.(pointerId)) {
              container.releasePointerCapture?.(pointerId);
            }
          } catch { /* ignore */ } finally { capturedId = null; }
        }
      }
    });
  };
  
  // Pointer enter/leave update state and hide/show as needed.
  const enter = () => { pointerInside = true; };
  const leave = (e) => {
    pointerInside = false;
    tip.style.visibility = "hidden";
    const { pointerId } = e;
    if (capture && typeof pointerId === "number" && capturedId === pointerId) {
      try {
        if (container.hasPointerCapture?.(pointerId)) {
          container.releasePointerCapture?.(pointerId);
        }
      } catch { /* ignore */ } finally { capturedId = null; }
    }
  };

  // Wire up listeners. pointer events cover mouse/touch/pen.
  container.addEventListener("pointerenter", enter);
  container.addEventListener("pointermove", move);
  container.addEventListener("pointerleave", leave);
  // Touchstart marks intent; tooltip then follows with pointermove as user drags.
  container.addEventListener("touchstart", enter, { passive: true });

  // Provide a cleanup function to prevent leaks.
  return function detach() {
    container.removeEventListener("pointerenter", enter);
    container.removeEventListener("pointermove", move);
    container.removeEventListener("pointerleave", leave);
    container.removeEventListener("touchstart", enter);

    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    // Try to release any lingering capture (precautionary).
    if (capturedId != null) {
      try {
        if (container.hasPointerCapture?.(capturedId)) {
          container.releasePointerCapture?.(capturedId);
        }
      } catch { /* ignore */ } finally { capturedId = null; }
    }
    tip.remove();
  };
}

/* Additional notes
** 1. Optional CSS to define the tooltip style in a separate style sheet (not reuqired)

    .plot-tooltip {
      position: absolute;
      pointer-events: none;
      background: rgba(20,20,30,0.9);
      color: white;
      padding: 6px 10px;
      border-radius: 6px;
      font: 12px/1.3 system-ui, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      z-index: 9999;
      max-width: 320px;
      white-space: nowrap;
    } 
** 2. Add the module to the main html

    <script type="module">
      import { attachHTMLTooltip } from './htmlTooltip.js';
      // ... your other imports or code here ...
    </script>

** 3. In the main script where the chart is created
    (a) Create a global variable to hold the tooltip.
        let detachTooltip; // holds cleanup for current chart’s tooltip
    (b) After chart is created (i.e., const chart = plot.plot(...)), detach previous tooltip.
        // Replace chart (first, detach previous tooltip to avoid leaks)
        if (detachTooltip) { detachTooltip(); detachTooltip = undefined; }
    (c) Append the chart to its DIV.
        const chartDiv = document.getElementById("chart");
        chartDiv.innerHTML = "";
        chartDiv.appendChild(chart);
    (d) Attach the tooltip to the new chart and store its detach function. 
        When using HTML content, set allowHTML: true. If you’d rather not allow HTML, switch to text.
        Pass the exact plotData array used by the marks so indices align.
        // Attach HTML tooltip to the new chart
        detachTooltip = attachHTMLTooltip(chart, plotData, {
          x: d => d.date,
          y: d => d.sales,
          hitRadius: 18,
          allowHTML: true, // if using `html'. Otherwise stay with text
          html: d => `
            <strong>${d.product}</strong><br>
            ${fmtYM.format(d.date)} • $${d.sales.toFixed(2)}
          `
        });
      }
** 4. Tooltip lives outside the SVG, so it won't show up in exports
** 5. If your chart uses Plot.plot instead of plot.plot, keep that consistent. 
      The returned SVG still exposes svg.scale.x and svg.scale.y.
** 6. Keep a separate detachTooltip per chart (e.g., potentially a Map from container id -> detach function).
*/