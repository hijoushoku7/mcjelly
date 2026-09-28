// Volumetric jelly: one lattice cell per skin pixel, 6 tets per cell, XPBD.
// Units: 1 = one skin pixel (0.5 cm).

export const PX_CM = 0.5;
const DENSITY = 1.05; // g/cm³
export const PLATE_R = 34;

export function makeParts(slim) {
  const a = slim ? 3 : 4;
  return [
    { name: 'head', min: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], ov: [32, 0] },
    { name: 'body', min: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], ov: [16, 32] },
    { name: 'rarm', min: [-4 - a, 12, -2], size: [a, 12, 4], uv: [40, 16], ov: [40, 32] },
    { name: 'larm', min: [4, 12, -2], size: [a, 12, 4], uv: [32, 48], ov: [48, 48] },
    { name: 'rleg', min: [-4, 0, -2], size: [4, 12, 4], uv: [0, 16], ov: [0, 32] },
    { name: 'lleg', min: [0, 0, -2], size: [4, 12, 4], uv: [16, 48], ov: [0, 48] },
  ];
}

// Skin face rects, keyed by direction index: 0:+x 1:-x 2:+y 3:-y 4:+z 5:-z
// uAxis/vAxis: [axis, sign] — which world axis the texture u/v follow.
export function faceRect(p, dir) {
  const [U, V] = p.uv, [w, h, d] = p.size;
  switch (dir) {
    case 0: return { o: [U + d + w, V + d], u: [2, -1], v: [1, -1] }; // left side
    case 1: return { o: [U, V + d], u: [2, 1], v: [1, -1] };          // right side
    case 2: return { o: [U + d, V], u: [0, 1], v: [2, 1] };           // top
    case 3: return { o: [U + d + w, V], u: [0, 1], v: [2, -1] };      // bottom
    case 4: return { o: [U + d, V + d], u: [0, 1], v: [1, -1] };      // front
    case 5: return { o: [U + 2 * d + w, V + d], u: [0, -1], v: [1, -1] }; // back
  }
}

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const KUHN = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];
const TET_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const key3 = (x, y, z) => ((y + 8) * 64 + (z + 32)) * 64 + (x + 32);

function joined(pa, pb, y) {
  if (pa === pb) return true;
  const s = pa + ',' + pb, t = pb + ',' + pa;
  const has = (q) => s === q || t === q;
  if (has('head,body') || has('body,rleg') || has('body,lleg')) return true;
  if (has('body,rarm') || has('body,larm')) return y >= 21; // shoulder only, arms swing free
  return false;
}

class UF {
  constructor(n) { this.p = new Int32Array(n).map((_, i) => i); }
  find(a) { while (this.p[a] !== a) a = this.p[a] = this.p[this.p[a]]; return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

export class Jelly {
  constructor(parts) {
    this.parts = parts;
    this.firmness = 0.4;
    this.damping = 0.45;
    this.gravity = 250;
    this.maxSubstep = 1 / 1200; // fixed ceiling so stiffness doesn't depend on frame rate; at 600 Hz it can't hold itself up
    this.grab = null;
    this.grabCompliance = 4e-6; // larger = the held spot lags and stretches more
    this.cuts = [];
    this.initLattice();
    this.rebuild(null);
  }

  initLattice() {
    const cellPart = [], cellPos = [], cellByKey = new Map();
    this.parts.forEach((p, pi) => {
      const [x0, y0, z0] = p.min, [w, h, d] = p.size;
      for (let z = z0; z < z0 + d; z++) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
        cellByKey.set(key3(x, y, z), cellPart.length);
        cellPart.push(pi); cellPos.push(x, y, z);
      }
    });
    const nC = cellPart.length;
    const latByKey = new Map(), latPos = [], inc = []; // inc[L] = list of slots (cell*8+corner)
    for (let c = 0; c < nC; c++) for (let k = 0; k < 8; k++) {
      const x = cellPos[c * 3] + (k & 1), y = cellPos[c * 3 + 1] + ((k >> 1) & 1), z = cellPos[c * 3 + 2] + ((k >> 2) & 1);
      const kk = key3(x, y, z);
      let L = latByKey.get(kk);
      if (L === undefined) { L = latPos.length / 3; latByKey.set(kk, L); latPos.push(x, y, z); inc.push([]); }
      inc[L].push(c * 8 + k);
    }
    const slotLat = new Int32Array(nC * 8);
    inc.forEach((list, L) => list.forEach((s) => (slotLat[s] = L)));
    Object.assign(this, { nC, cellPart: Int8Array.from(cellPart), cellPos: Int32Array.from(cellPos), cellByKey, latPos: Int32Array.from(latPos), inc, slotLat });
  }

  separated(a, b) {
    for (const s of this.cuts) if (s[a] && s[b] && s[a] !== s[b]) return true;
    return false;
  }

  // (Re)derive vertices from cell corners: corners merge unless their cells are unjoined or cut apart.
  rebuild(old) {
    const { nC, inc, cellPart, latPos, slotLat } = this;
    const uf = new UF(nC * 8);
    inc.forEach((list, L) => {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i] >> 3, b = list[j] >> 3;
        if (joined(this.parts[cellPart[a]].name, this.parts[cellPart[b]].name, latPos[L * 3 + 1]) && !this.separated(a, b))
          uf.union(list[i], list[j]);
      }
    });
    const slotVert = new Int32Array(nC * 8), rootId = new Map();
    let n = 0;
    for (let s = 0; s < nC * 8; s++) {
      const r = uf.find(s);
      let v = rootId.get(r);
      if (v === undefined) { v = n++; rootId.set(r, v); }
      slotVert[s] = v;
    }
    const x = new Float32Array(n * 3), v = new Float32Array(n * 3), rest = new Float32Array(n * 3), lat = new Int32Array(n), count = new Float32Array(n);
    for (let s = 0; s < nC * 8; s++) {
      const i = slotVert[s], L = slotLat[s];
      lat[i] = L; count[i]++;
      for (let a = 0; a < 3; a++) {
        rest[i * 3 + a] = latPos[L * 3 + a];
        x[i * 3 + a] = old ? old.x[old.slotVert[s] * 3 + a] : latPos[L * 3 + a];
        v[i * 3 + a] = old ? old.v[old.slotVert[s] * 3 + a] : 0;
      }
    }
    const w = count.map((c) => 8 / c);

    // pieces
    const cuf = new UF(nC), first = new Int32Array(n).fill(-1);
    for (let s = 0; s < nC * 8; s++) { const i = slotVert[s]; if (first[i] < 0) first[i] = s >> 3; else cuf.union(first[i], s >> 3); }
    const pieceOfRoot = new Map(), cellPiece = new Int32Array(nC);
    for (let c = 0; c < nC; c++) { const r = cuf.find(c); if (!pieceOfRoot.has(r)) pieceOfRoot.set(r, pieceOfRoot.size); cellPiece[c] = pieceOfRoot.get(r); }
    const piece = new Int32Array(n);
    for (let s = 0; s < nC * 8; s++) piece[slotVert[s]] = cellPiece[s >> 3];

    // tets + edges
    const tets = new Int32Array(nC * 6 * 4), tetRest = new Float32Array(nC * 6);
    const edgeSet = new Map();
    for (let c = 0, t = 0; c < nC; c++) for (const q of KUHN) {
      // mirror the split per cell parity so the diagonals don't all lean one way
      const m = (this.cellPos[c * 3] & 1) | ((this.cellPos[c * 3 + 1] & 1) << 1) | ((this.cellPos[c * 3 + 2] & 1) << 2);
      for (let k = 0; k < 4; k++) tets[t * 4 + k] = slotVert[c * 8 + (q[k] ^ m)];
      tetRest[t] = tetVolume(rest, tets, t);
      for (const [a, b] of TET_EDGES) {
        const i = tets[t * 4 + a], j = tets[t * 4 + b], kk = Math.min(i, j) * n + Math.max(i, j);
        if (!edgeSet.has(kk)) edgeSet.set(kk, [Math.min(i, j), Math.max(i, j)]);
      }
      t++;
    }
    const edges = Int32Array.from([...edgeSet.values()].flat());
    const edgeRest = new Float32Array(edges.length / 2);
    for (let e = 0; e < edgeRest.length; e++) edgeRest[e] = dist(rest, edges[e * 2], edges[e * 2 + 1]);

    Object.assign(this, { n, x, v, rest, w, w0: w.slice(), lat, slotVert, piece, nPieces: pieceOfRoot.size, tets, tetRest, edges, edgeRest });
    this.restVolume = tetRest.reduce((s, V) => s + Math.abs(V), 0);
    this.buildSurface();
    this.prev = new Float32Array(n * 3);
  }

  buildSurface() {
    const { nC, cellPos, cellPart, cellByKey, slotVert, parts } = this;
    const quads = []; // [v0,v1,v2,v3, dir, cell, skin(bool)]
    for (let c = 0; c < nC; c++) {
      const [cx, cy, cz] = [cellPos[c * 3], cellPos[c * 3 + 1], cellPos[c * 3 + 2]];
      const p = parts[cellPart[c]];
      for (let dir = 0; dir < 6; dir++) {
        const D = DIRS[dir], a = dir >> 1, s = D[a] > 0 ? 1 : 0;
        const nb = cellByKey.get(key3(cx + D[0], cy + D[1], cz + D[2]));
        const u = (a + 1) % 3, vv = (a + 2) % 3;
        const ks = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([bu, bv]) => (s << a) | (bu << u) | (bv << vv));
        if (!s) ks.reverse();
        const vs = ks.map((k) => slotVert[c * 8 + k]);
        if (nb !== undefined) {
          const shared = ks.every((k) => slotVert[c * 8 + k] === slotVert[nb * 8 + (k ^ (1 << a))]);
          if (shared) continue;
        }
        const onBox = D[a] > 0 ? [cx, cy, cz][a] === p.min[a] + p.size[a] - 1 : [cx, cy, cz][a] === p.min[a];
        quads.push(vs[0], vs[1], vs[2], vs[3], dir, c, onBox ? 1 : 0);
      }
    }
    this.quads = Int32Array.from(quads);
    this.surfaceVersion = (this.surfaceVersion || 0) + 1;
  }

  // Plane n·x = d (world), `inStroke(x,y,z)` limits the cut to where the blade actually went.
  cut(nrm, d, inStroke, push = 25) {
    const { nC, slotVert, x } = this;
    const side = new Int8Array(nC);
    let any = false, pos = 0, neg = 0;
    for (let c = 0; c < nC; c++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 8; k++) { const i = slotVert[c * 8 + k] * 3; cx += x[i]; cy += x[i + 1]; cz += x[i + 2]; }
      cx /= 8; cy /= 8; cz /= 8;
      const sd = nrm[0] * cx + nrm[1] * cy + nrm[2] * cz - d;
      if (Math.abs(sd) < 1.8 && inStroke(cx, cy, cz)) { side[c] = sd >= 0 ? 1 : -1; any = true; sd >= 0 ? pos++ : neg++; }
    }
    if (!any || !pos || !neg) return false;
    this.cuts.push(side);
    this.rebuild({ x: this.x, v: this.v, slotVert: this.slotVert });
    // nudge the two faces of the cut apart
    for (let c = 0; c < nC; c++) if (side[c]) for (let k = 0; k < 8; k++) {
      const i = this.slotVert[c * 8 + k] * 3;
      for (let a = 0; a < 3; a++) this.v[i + a] += nrm[a] * side[c] * push / 8;
    }
    return true;
  }

  reset() { this.cuts = []; this.grab = null; this.rebuild(null); }

  step(dt) {
    const n = Math.ceil(dt / this.maxSubstep - 1e-6), h = dt / n;
    for (let s = 0; s < n; s++) this.substep(h);
  }

  substep(h) {
    this.tick = (this.tick || 0) + 1;
    const { n, x, v, w, prev, edges, edgeRest, tets, tetRest } = this;
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      v[i * 3 + 1] -= this.gravity * h;
    }
    prev.set(x);
    for (let i = 0; i < n * 3; i++) x[i] += v[i] * h;
    if (this.grab) {
      // soft XPBD attachment: the held spot is tugged toward the cursor and the rest of the jelly pulls back
      const { ids, offs, target } = this.grab, ag = this.grabCompliance / (h * h);
      for (let j = 0; j < ids.length; j++) {
        const i = ids[j], k = w[i] / (w[i] + ag);
        for (let a = 0; a < 3; a++) x[i * 3 + a] += (target[a] + offs[j * 3 + a] - x[i * 3 + a]) * k;
      }
    }

    // firmness 0..1 → compliance, log scale
    const alpha = Math.pow(10, -5 - 2.5 * this.firmness) / (h * h);
    const flip = (this.tick & 1) === 1; // alternate sweep order so Gauss-Seidel doesn't drift one way
    const nE = edgeRest.length, nT = tetRest.length;
    for (let ee = 0; ee < nE; ee++) {
      const e = flip ? nE - 1 - ee : ee;
      const i = edges[e * 2], j = edges[e * 2 + 1], wi = w[i], wj = w[j], ws = wi + wj;
      if (ws === 0) continue;
      const dx = x[i * 3] - x[j * 3], dy = x[i * 3 + 1] - x[j * 3 + 1], dz = x[i * 3 + 2] - x[j * 3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const lam = -(len - edgeRest[e]) / (ws + alpha) / len;
      x[i * 3] += dx * lam * wi; x[i * 3 + 1] += dy * lam * wi; x[i * 3 + 2] += dz * lam * wi;
      x[j * 3] -= dx * lam * wj; x[j * 3 + 1] -= dy * lam * wj; x[j * 3 + 2] -= dz * lam * wj;
    }
    for (let tt = 0; tt < nT; tt++) {
      const t = flip ? nT - 1 - tt : tt;
      const a = tets[t * 4] * 3, b = tets[t * 4 + 1] * 3, c = tets[t * 4 + 2] * 3, d = tets[t * 4 + 3] * 3;
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const x1 = x[b] - ax, y1 = x[b + 1] - ay, z1 = x[b + 2] - az;
      const x2 = x[c] - ax, y2 = x[c + 1] - ay, z2 = x[c + 2] - az;
      const x3 = x[d] - ax, y3 = x[d + 1] - ay, z3 = x[d + 2] - az;
      const bx = y2 * z3 - z2 * y3, by = z2 * x3 - x2 * z3, bz = x2 * y3 - y2 * x3; // e2×e3
      const cx = y3 * z1 - z3 * y1, cy = z3 * x1 - x3 * z1, cz = x3 * y1 - y3 * x1; // e3×e1
      const dx = y1 * z2 - z1 * y2, dy = z1 * x2 - x1 * z2, dz = x1 * y2 - y1 * x2; // e1×e2
      const gx = -(bx + cx + dx), gy = -(by + cy + dy), gz = -(bz + cz + dz);
      const wa = w[a / 3], wb = w[b / 3], wc = w[c / 3], wd = w[d / 3];
      const den = (wa * (gx * gx + gy * gy + gz * gz) + wb * (bx * bx + by * by + bz * bz) + wc * (cx * cx + cy * cy + cz * cz) + wd * (dx * dx + dy * dy + dz * dz)) / 36;
      if (den < 1e-12) continue;
      const s = -((x1 * bx + y1 * by + z1 * bz) / 6 - tetRest[t]) / den / 6;
      x[a] += gx * s * wa; x[a + 1] += gy * s * wa; x[a + 2] += gz * s * wa;
      x[b] += bx * s * wb; x[b + 1] += by * s * wb; x[b + 2] += bz * s * wb;
      x[c] += cx * s * wc; x[c + 1] += cy * s * wc; x[c + 2] += cz * s * wc;
      x[d] += dx * s * wd; x[d + 1] += dy * s * wd; x[d + 2] += dz * s * wd;
    }
    // ponytail: collisions every 4th substep only; per-substep if pieces tunnel
    if (this.tick % 4 === 0) this.collide();
    // floor with friction, and the plate's rim keeps pieces on the table
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(x[i * 3], x[i * 3 + 2]);
      if (r > PLATE_R) { x[i * 3] *= PLATE_R / r; x[i * 3 + 2] *= PLATE_R / r; }
      if (x[i * 3 + 1] < 0) {
        x[i * 3 + 1] = 0;
        x[i * 3] = prev[i * 3] + (x[i * 3] - prev[i * 3]) * 0.3;
        x[i * 3 + 2] = prev[i * 3 + 2] + (x[i * 3 + 2] - prev[i * 3 + 2]) * 0.3;
      }
    }
    // cap speed: violent spinning can make the volume solve feed energy back each substep and explode to NaN
    const VMAX = 1000;
    for (let i = 0; i < n * 3; i++) v[i] = Math.max(-VMAX, Math.min(VMAX, (x[i] - prev[i]) / h));
    this.dampen(h);
  }

  // ponytail: vertex-vs-vertex only (radius 0.9); thin slivers can still pass edge-through-edge.
  collide() {
    const { n, x, w, lat, piece, latPos } = this;
    const R = 0.9, size = 4099;
    if (!this.hHead || this.hNext.length < n) { this.hHead = new Int32Array(size); this.hNext = new Int32Array(n * 2); }
    const head = this.hHead.fill(-1), next = this.hNext;
    const hash = (a, b, c) => (Math.abs((a * 92837111) ^ (b * 689287499) ^ (c * 283923481))) % size;
    for (let i = 0; i < n; i++) {
      const hsh = hash(Math.floor(x[i * 3]), Math.floor(x[i * 3 + 1]), Math.floor(x[i * 3 + 2]));
      next[i] = head[hsh]; head[hsh] = i;
    }
    for (let i = 0; i < n; i++) {
      const fx = Math.floor(x[i * 3]), fy = Math.floor(x[i * 3 + 1]), fz = Math.floor(x[i * 3 + 2]);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        for (let j = head[hash(fx + ox, fy + oy, fz + oz)]; j >= 0; j = next[j]) {
          if (j <= i) continue;
          const Li = lat[i], Lj = lat[j];
          if (Li === Lj) continue;
          if (piece[i] === piece[j]) {
            const cheb = Math.max(Math.abs(latPos[Li * 3] - latPos[Lj * 3]), Math.abs(latPos[Li * 3 + 1] - latPos[Lj * 3 + 1]), Math.abs(latPos[Li * 3 + 2] - latPos[Lj * 3 + 2]));
            if (cheb <= 1) continue;
          }
          const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= R * R || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), ws = w[i] + w[j];
          if (ws === 0) continue;
          const corr = (R - d) / d / ws;
          x[i * 3] -= dx * corr * w[i]; x[i * 3 + 1] -= dy * corr * w[i]; x[i * 3 + 2] -= dz * corr * w[i];
          x[j * 3] += dx * corr * w[j]; x[j * 3 + 1] += dy * corr * w[j]; x[j * 3 + 2] += dz * corr * w[j];
        }
      }
    }
  }

  // damp velocity relative to each piece's mean (internal damping, leaves free fall alone)
  dampen(h) {
    const { n, v, piece, nPieces, w0 } = this;
    const k = Math.exp(-this.damping * 30 * h);
    const mv = new Float64Array(nPieces * 4);
    for (let i = 0; i < n; i++) { const p = piece[i] * 4, m = 1 / w0[i]; mv[p] += v[i * 3] * m; mv[p + 1] += v[i * 3 + 1] * m; mv[p + 2] += v[i * 3 + 2] * m; mv[p + 3] += m; }
    for (let i = 0; i < n; i++) {
      const p = piece[i] * 4;
      for (let a = 0; a < 3; a++) { const m = mv[p + a] / mv[p + 3]; v[i * 3 + a] = m + (v[i * 3 + a] - m) * k; }
    }
  }

  stats() {
    let vol = 0, ke = 0, mass = 0;
    for (let t = 0; t < this.tetRest.length; t++) vol += Math.abs(tetVolume(this.x, this.tets, t));
    const cellMassG = DENSITY * PX_CM ** 3;
    for (let i = 0; i < this.n; i++) {
      const m = cellMassG / this.w0[i] / 1000; // kg
      const vx = this.v[i * 3], vy = this.v[i * 3 + 1], vz = this.v[i * 3 + 2];
      ke += 0.5 * m * (vx * vx + vy * vy + vz * vz) * (PX_CM / 100) ** 2;
      mass += m * 1000;
    }
    return { mass, volume: vol / this.restVolume, keMicroJ: ke * 1e6, pieces: this.nPieces };
  }
}

function dist(p, i, j) {
  return Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
}
function tetVolume(p, tets, t) {
  const [a, b, c, d] = [tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]];
  const e = (i, k) => p[i * 3 + k] - p[a * 3 + k];
  const [x1, y1, z1, x2, y2, z2, x3, y3, z3] = [e(b, 0), e(b, 1), e(b, 2), e(c, 0), e(c, 1), e(c, 2), e(d, 0), e(d, 1), e(d, 2)];
  return (x1 * (y2 * z3 - z2 * y3) - y1 * (x2 * z3 - z2 * x3) + z1 * (x2 * y3 - y2 * x3)) / 6;
}
