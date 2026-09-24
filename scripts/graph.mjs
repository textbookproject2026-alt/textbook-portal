/**
 * The keyword graph's layout, computed at BUILD time so the page ships a
 * finished SVG: it reads, and every node is a working link, with no script at
 * all. src/portal.js only adds highlighting and the selection panel on top.
 *
 * A plain Fruchterman–Reingold layout from a deterministic start (nodes on a
 * spiral, in label order), so the same keywords always give the same picture
 * and the page doesn't churn between builds that change nothing.
 */

export const VIEW = { width: 720, height: 440, pad: 36 };

/** Node radius from how many pages carry the keyword. */
export const radius = (pages) => 4 + Math.min(10, Math.sqrt(pages) * 2.2);

export function layout({ nodes, edges }, { iterations = 400 } = {}) {
  const { width, height, pad } = VIEW;
  const n = nodes.length;
  if (n === 0) return [];
  const index = new Map(nodes.map((node, i) => [node.key, i]));
  const cx = width / 2;
  const cy = height / 2;

  // Golden-angle spiral: evenly spread, no randomness.
  const pos = nodes.map((_, i) => {
    const r = 14 * Math.sqrt(i + 0.5);
    const a = i * 2.399963229728653;
    return { x: cx + r * Math.cos(a) * 1.4, y: cy + r * Math.sin(a) };
  });
  if (n === 1) return [{ ...nodes[0], ...pos[0] }];

  const area = (width - 2 * pad) * (height - 2 * pad);
  const k = 1.15 * Math.sqrt(area / n);
  const links = edges
    .map((e) => ({ s: index.get(e.a), t: index.get(e.b), w: e.weight }))
    .filter((e) => e.s !== undefined && e.t !== undefined);

  let temp = width / 8;
  const cool = temp / (iterations + 1);
  for (let step = 0; step < iterations; step++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) (dx = 0.01 * (i - j)), (dy = 0.01), (d = Math.hypot(dx, dy));
        const f = (k * k) / d;
        disp[i].x += (dx / d) * f;
        disp[i].y += (dy / d) * f;
        disp[j].x -= (dx / d) * f;
        disp[j].y -= (dy / d) * f;
      }
    for (const { s, t, w } of links) {
      const dx = pos[s].x - pos[t].x;
      const dy = pos[s].y - pos[t].y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      // Stronger for keywords that share many pages, but only gently.
      const f = ((d * d) / k) * (1 + Math.log(w));
      disp[s].x -= (dx / d) * f;
      disp[s].y -= (dy / d) * f;
      disp[t].x += (dx / d) * f;
      disp[t].y += (dy / d) * f;
    }
    // A pull to the middle keeps unconnected keywords from drifting to the edge.
    for (let i = 0; i < n; i++) {
      disp[i].x += (cx - pos[i].x) * 0.02 * (k / 10);
      disp[i].y += (cy - pos[i].y) * 0.04 * (k / 10);
      const d = Math.max(0.01, Math.hypot(disp[i].x, disp[i].y));
      pos[i].x += (disp[i].x / d) * Math.min(d, temp);
      pos[i].y += (disp[i].y / d) * Math.min(d, temp);
    }
    temp = Math.max(0.5, temp - cool);
  }

  // Fit to the view. Each axis on its own: the view is wide and a textbook's
  // keywords read better spread across it than kept square.
  const fit = () => {
    const xs = pos.map((p) => p.x);
    const ys = pos.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const sx = (width - 2 * pad - 90) / Math.max(1, maxX - minX); // room for the rightmost label
    const sy = (height - 2 * pad) / Math.max(1, maxY - minY);
    for (const p of pos) {
      p.x = (p.x - minX) * sx + pad + 20;
      p.y = (p.y - minY) * sy + pad;
    }
  };
  fit();

  // Labels are what collide, not dots. Estimate each label's box and push
  // overlapping pairs apart, mostly vertically, until nothing overlaps or the
  // passes run out. Deterministic, like the rest.
  const box = (i) => {
    const w = String(nodes[i].label).length * 6.4 + 22;
    return { x: pos[i].x - 8, y: pos[i].y - 9, w, h: 18 };
  };
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = box(i);
        const b = box(j);
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const dir = pos[i].y < pos[j].y || (pos[i].y === pos[j].y && i < j) ? -1 : 1;
        const push = Math.min(oy, 6) / 2 + 0.5;
        pos[i].y += dir * push;
        pos[j].y -= dir * push;
        if (ox < 30) {
          const dx = pos[i].x < pos[j].x ? -1 : 1;
          pos[i].x += dx * 1.5;
          pos[j].x -= dx * 1.5;
        }
      }
    for (const p of pos) {
      p.y = Math.min(height - pad / 2, Math.max(pad / 2, p.y));
      p.x = Math.min(width - pad, Math.max(pad / 2, p.x));
    }
    if (!moved) break;
  }

  return nodes.map((node, i) => ({ ...node, x: Math.round(pos[i].x), y: Math.round(pos[i].y) }));
}
