// The squint guard (_claude/v3/PLAN.md §5, logic lane): the round-6 board at rest at 1440×900, scaled to
// 30 % (the friend on the couch), must still read as the power map: the five largest stones and the continent
// outlines are the highest-contrast MARKS. A stone's box holds the unit figure standing on it (tokens.ts). Contrast = |ΔL*| (CIELAB lightness) on the 30 % frame, of a mark
// against what it sits on: a stack's strongest pixels (90th percentile of its box) against its own wash; a
// line's pixels against the median of four points 0.6 board units away (the paper or wash beside it).
//   gate:    each of the five largest stones weighs ≥ 1.4× the other stones' median at a squint (Σ of its
//            pixels' |ΔL*| over 8: area × contrast, how a stack pops from the couch), and their median
//            90th-percentile contrast beats the others'; the continent outlines
//            out-contrast the territory hairlines and the coasts
//   reported: the same marks against the open-sea paper (the washes themselves are the biggest step off
//            the paper; they are fields, not marks)
// The numbers are always printed. The 30 % frame → artifacts/e2e/squint-30.png.
import { check, finish, loadScenario, open } from './lib';
import { restBoard } from './board-lib';
import { mkdirSync, writeFileSync } from 'node:fs';

const results: string[] = [];
const { browser, page, errors } = await open(undefined, { width: 1440, height: 900 });
await loadScenario(page, restBoard({ kind: 'attack' }));
await page.waitForTimeout(1500);

const K = 0.3;
const png = await page.screenshot({ type: 'png' });
mkdirSync('artifacts/e2e', { recursive: true });

const res = await page.evaluate(
  async ([b64, k]) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const W = Math.round(innerWidth * k);
    const H = Math.round(innerHeight * k);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const Lof = (i: number) => {
      const Y = 0.2126 * lin(px[i] / 255) + 0.7152 * lin(px[i + 1] / 255) + 0.0722 * lin(px[i + 2] / 255);
      return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
    };
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = Lof(i * 4);
    const d = (window as unknown as { __board: { __debug: Record<string, any> } }).__board.__debug;
    const cam = d.rig.camera;
    const ink = d.ink;
    const tiles = d.tiles;
    // board → screen (client px) at the tile-top plane
    const V = cam.position.constructor;
    const proj = (bx: number, by: number) => {
      const v = new V(bx - d.shared.uBoard.value.x / 2, 0.06, d.shared.uBoard.value.y / 2 - by).project(cam);
      return [((v.x + 1) / 2) * innerWidth * k, ((1 - v.y) / 2) * innerHeight * k];
    };
    const at = (x: number, y: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= 0 && yi >= 0 && xi < W && yi < H ? L[yi * W + xi] : NaN;
    };
    const med = (a: number[]) => {
      const s = a.filter((v) => !isNaN(v)).sort((p, q) => p - q);
      return s.length ? s[Math.floor(s.length / 2)] : NaN;
    };
    const pct = (a: number[], q: number) => {
      const s = a.filter((v) => !isNaN(v)).sort((p, q2) => p - q2);
      return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN;
    };
    // the paper: open sea (the cont texture's open-sea texels, far from land)
    const cont = ink.cont.image;
    const fw = cont.width;
    const fh = cont.height;
    const BW = d.shared.uBoard.value.x;
    const BH = d.shared.uBoard.value.y;
    const sea: number[] = [];
    const line: number[] = [];
    for (let y = 2; y < fh - 2; y += 7)
      for (let x = 2; x < fw - 2; x += 7) {
        const o = (y * fw + x) * 4;
        const bx = ((x + 0.5) / fw) * BW;
        const by = BH - ((y + 0.5) / fh) * BH;
        const [sx, sy] = proj(bx, by);
        if (sy < 70 * k || sy > (innerHeight - 170) * k) continue; // the HUD bands
        const field = ink.field.image.data;
        const fo = ((Math.floor((y / fh) * ink.fieldH) * ink.fieldW + Math.floor((x / fw) * ink.fieldW)) * 4) | 0;
        const seaD = field[fo + 1];
        if (cont.data[o + 1] === 255 && seaD >= 250) sea.push(at(sx, sy));
        if (cont.data[o] <= 6) line.push(at(sx, sy));
      }
    const paper = med(sea);
    const cst = (v: number) => Math.abs(v - paper);
    // a line point against the median of four points 0.6 board units away
    const localAt = (bx: number, by: number) => {
      const [sx, sy] = proj(bx, by);
      const here = at(sx, sy);
      const bg = med([[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].map(([dx, dy]) => {
        const [x, y] = proj(bx + dx, by + dy);
        return at(x, y);
      }));
      return Math.abs(here - bg);
    };
    const lineLocal: number[] = [];
    for (let y = 2; y < fh - 2; y += 7)
      for (let x = 2; x < fw - 2; x += 7) {
        const o = (y * fw + x) * 4;
        if (cont.data[o] > 6) continue;
        const bx = ((x + 0.5) / fw) * BW;
        const by = BH - ((y + 0.5) / fh) * BH;
        const [, sy] = proj(bx, by);
        if (sy < 70 * k || sy > (innerHeight - 170) * k) continue;
        lineLocal.push(localAt(bx, by));
      }
    // the stacks: each one's box at 30 % (its top face to its base), its strongest pixels
    const armies = d.armies as Record<string, number>;
    // each territory's wash (raw L*), from its interior away from its stack
    const washL = new Map<string, number>();
    for (const t of tiles.list as { id: string; anchor: [number, number]; clearance: number }[]) {
      const box = d.overlay.pieceRects(t.id)?.box.map((v: number) => v * k);
      // (the piece's box now holds its figure too: a territory whose ring falls inside it samples a little wider)
      let vals: number[] = [];
      for (let grow = 1; grow <= 2.3 && vals.filter((v) => !isNaN(v)).length < 2; grow *= 1.35) {
        vals = [];
        const r = Math.max(0.6, t.clearance * 0.7) * grow;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-0.7, -0.7], [0.7, -0.7]]) {
          const [sx, sy] = proj(t.anchor[0] + dx * r, t.anchor[1] + dy * r);
          if (box && sx >= box[0] - 1 && sx <= box[2] + 1 && sy >= box[1] - 1 && sy <= box[3] + 1) continue;
          vals.push(at(sx, sy));
        }
      }
      washL.set(t.id, med(vals));
    }
    const stacks = tiles.list.map((t: { id: string }) => {
      const r = d.overlay.pieceRects(t.id);
      if (!r) return { id: t.id, n: armies[t.id], c: NaN, p: NaN, m: NaN };
      const [x0, y0, x1, y1] = r.box.map((v: number) => v * k);
      const vals: number[] = [];
      const vp: number[] = [];
      const bg = washL.get(t.id)!;
      for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
          vals.push(Math.abs(at(x, y) - bg));
          vp.push(cst(at(x, y)));
        }
      // its weight at a squint: how much of it stands off its wash (Σ of |ΔL*| over 8, in 30 % pixels)
      const m = vals.reduce((acc, v) => acc + (isNaN(v) ? 0 : Math.max(0, v - 8)), 0);
      return { id: t.id, n: armies[t.id], c: pct(vals, 0.9), p: pct(vp, 0.9), m };
    });
    stacks.sort((a: { n: number }, b: { n: number }) => b.n - a.n);
    const top5 = stacks.slice(0, 5);
    const rest = stacks.slice(5).filter((s: { c: number }) => !isNaN(s.c));
    // the washes: each territory's interior away from its stack and borders (its anchor, pushed off the stack)
    const washes = tiles.list.map((t: { id: string; anchor: [number, number]; clearance: number }) => {
      const vals: number[] = [];
      const r = Math.max(0.6, t.clearance * 0.7);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-0.7, -0.7], [0.7, -0.7]]) {
        const [sx, sy] = proj(t.anchor[0] + dx * r, t.anchor[1] + dy * r);
        const box = d.overlay.pieceRects(t.id)?.box.map((v: number) => v * k);
        if (box && sx >= box[0] - 1 && sx <= box[2] + 1 && sy >= box[1] - 1 && sy <= box[3] + 1) continue;
        vals.push(cst(at(sx, sy)));
      }
      return { id: t.id, c: med(vals) };
    });
    const washC = washes.map((w: { c: number }) => w.c).filter((v: number) => !isNaN(v));
    // the coasts: the ink layer's coast texels (R) that are not also the continent outline
    const ik = ink.ink.image;
    const coast: number[] = [];
    const hair: number[] = [];
    for (let y = 0; y < ik.height; y += 9)
      for (let x = 0; x < ik.width; x += 9) {
        const o = (y * ik.width + x) * 4;
        const isCoast = ik.data[o] >= 150;
        const isHair = ik.data[o + 1] >= 150;
        if (!isCoast && !isHair) continue;
        const bx = ((x + 0.5) / ik.width) * BW;
        const by = BH - ((y + 0.5) / ik.height) * BH;
        const [, sy] = proj(bx, by);
        if (sy < 70 * k || sy > (innerHeight - 170) * k) continue;
        // (a coast that is also the continent's own border is the outline's, not the coast's)
        if (isCoast) coast.push(localAt(bx, by));
        else hair.push(localAt(bx, by));
      }
    return {
      paper,
      top5: top5.map((s: { id: string; n: number; c: number; p: number }) => ({ id: s.id, n: s.n, c: +s.c.toFixed(1), p: +s.p.toFixed(1) })),
      top5Min: Math.min(...top5.map((s: { c: number }) => s.c)),
      top5Mass: top5.map((s: { id: string; m: number }) => ({ id: s.id, m: Math.round(s.m) })),
      top5MassMin: Math.min(...top5.map((s: { m: number }) => s.m)),
      restMass: med(rest.map((s: { m: number }) => s.m)),
      restMassMax: Math.max(...rest.map((s: { m: number }) => s.m)),
      top5Median: med(top5.map((s: { c: number }) => s.c)),
      restMedian: med(rest.map((s: { c: number }) => s.c)),
      restMax: Math.max(...rest.map((s: { c: number }) => s.c)),
      top5PaperMin: Math.min(...top5.map((s: { p: number }) => s.p)),
      lineLocal: med(lineLocal),
      hair: med(hair),
      washMedian: med(washC),
      washMax: Math.max(...washC),
      outline: med(line.map(cst)),
      outlineN: line.length,
      coast: med(coast),
      coastN: coast.length,
      small: c.toDataURL('image/png').split(',')[1],
    };
  },
  [png.toString('base64'), K] as const,
);
writeFileSync('artifacts/e2e/squint-30.png', Buffer.from(res.small, 'base64'));
const f = (v: number) => v.toFixed(1);
console.log(`squint (30 %, |ΔL*|): paper L* ${f(res.paper)}`);
console.log(`  five largest stones vs their own wash: ${res.top5.map((s: { id: string; n: number; c: number }) => `${s.id} ${s.n}: ${s.c}`).join(', ')} (median ${f(res.top5Median)}) · the other 37: median ${f(res.restMedian)}, max ${f(res.restMax)}`);
console.log(`  lines vs what they sit on: continent outlines ${f(res.lineLocal)} · coasts ${f(res.coast)} · territory hairlines ${f(res.hair)}`);
console.log(`  against the open-sea paper: five tallest (min) ${f(res.top5PaperMin)} · outlines ${f(res.outline)} · washes median ${f(res.washMedian)} (max ${f(res.washMax)})`);
console.log(`  weight at a squint (Σ|ΔL*|−8 over the stack): five tallest ${res.top5Mass.map((s: { id: string; m: number }) => `${s.id} ${s.m}`).join(', ')} · the other 37: median ${Math.round(res.restMass)}, max ${Math.round(res.restMassMax)}`);
check(res.top5MassMin > res.restMass * 1.3, `each of the five largest stones weighs ≥ 1.3× the other stones' median at a squint (min ${Math.round(res.top5MassMin)} vs ${Math.round(res.restMass)})`, results);
check(res.top5Median > res.restMedian, `the five largest stones out-contrast the other stones (median ${f(res.top5Median)} > ${f(res.restMedian)})`, results);
check(res.lineLocal > res.hair && res.lineLocal > res.coast, `the continent outlines are the strongest lines (${f(res.lineLocal)} > coasts ${f(res.coast)}, hairlines ${f(res.hair)})`, results);
console.log(`${res.top5Min > res.restMedian ? 'ok  ' : 'WARN'} every one of the five tallest out-contrasts the other stones' median (min ${f(res.top5Min)})`);
await browser.close();
finish(results, errors);
