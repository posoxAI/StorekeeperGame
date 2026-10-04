#!/usr/bin/env node
// Level generator for Storekeeper.
//
// Usage:
//   node tools/generate-levels.js          print the twelve levels with their minimum pushes and a solution
//   node tools/generate-levels.js --json   print them as JSON instead
//
// The run is deterministic: the seeds below reproduce exactly the levels that ship in index.html.
// It takes about fifteen seconds.
//
// How a level is made
// -------------------
// 1. Take a hand-drawn room and put the marked spots on random floor cells.
// 2. Start from the solved position (a crate on every spot) and search backwards: instead of pushing
//    crates, the keeper pulls them. A breadth-first search over every position reachable by pulling
//    visits each position at its exact distance from the solved one, and that distance is the minimum
//    number of pushes needed to solve it.
// 3. Keep the placements whose search goes deepest, then pick a position at the wanted depth where
//    no crate already stands on a spot and the crates sit far from the spots.
//
// A position is a set of crate cells plus the region the keeper can walk in. Two positions that differ
// only in where the keeper stands inside the same region are the same position.

'use strict';

// ---------------------------------------------------------------------------------------------
// Rooms. '#' is a wall, a space is floor. Cells connected to the border are outside the room.
// ---------------------------------------------------------------------------------------------
const ROOMS = {
  A: ['  ####  ', '###  ###', '#      #', '#  #   #', '#      #', '########'],
  B: ['#######', '#  #  #', '#     #', '## #  #', '#     #', '#   ###', '#####  '],
  C: [' ##### ', '##   ##', '#     #', '#  #  #', '#     #', '##   ##', ' ##### '],
  D: ['########', '#   #  #', '#      #', '### #  #', '#      #', '#  #   #', '########'],
  E: ['  #####', '###   #', '#     #', '# ##  ##', '#      #', '#   #  #', '########'],
  F: ['#########', '#   #   #', '#       #', '#  ###  #', '#       #', '#   #   #', '#########'],
  G: [' ###### ', '##    # ', '#  ## ##', '#      #', '## #   #', ' #    ##', ' ###### '],
  H: ['########', '#      #', '# #  # #', '#      #', '# #  # #', '#      #', '########'],
  I: ['#########', '#  #    #', '#     # #', '# #     #', '#    #  #', '#       #', '#########'],
  J: ['  ###### ', '###    ##', '#   #   #', '# #   # #', '#   #   #', '##     ##', ' ####### '],
  K: ['######  ', '#    ###', '#  #   #', '#      #', '###  # #', '  #    #', '  ######'],
  L: ['#######', '#     #', '# # # #', '#     #', '# # # #', '#     #', '#######'],
};

// The level list: room, number of crates, minimum pushes wanted.
const PLAN = [
  ['J', 2, 4], ['C', 2, 6], ['L', 2, 9], ['H', 2, 11],
  ['B', 3, 13], ['E', 3, 15], ['K', 3, 17], ['A', 3, 18], ['G', 3, 22],
  ['I', 4, 23], ['D', 4, 24], ['F', 4, 27],
];

const EXPLORE_SEED = 20261004;   // seed for the random placements of marked spots
const PICK_SEED = 77;            // seed for choosing among positions of equal depth
const PLACEMENTS = { 2: 120, 3: 160, 4: 90 };  // placements tried per room, by crate count
const KEEP = 12;                 // deepest placements kept per room and crate count
const STATE_LIMIT = 900000;      // give up on a placement whose search grows past this

// Small seeded generator (mulberry32) so that every run gives the same levels.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turns the drawing of a room into cell arrays. Cells are numbered y * W + x.
function prep(rows) {
  const H = rows.length, W = Math.max(...rows.map(r => r.length));
  const wall = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) wall[y * W + x] = (rows[y][x] === '#') ? 1 : 0;
  // floor = cells that are not walls and cannot be reached from the border
  const out = new Uint8Array(W * H), st = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && !wall[y * W + x]) { out[y * W + x] = 1; st.push(y * W + x); }
  }
  const D = [1, -1, W, -W];
  while (st.length) {
    const c = st.pop();
    for (const d of D) {
      const n = c + d;
      if (n < 0 || n >= W * H) continue;
      if (Math.abs(d) === 1 && ((n / W) | 0) !== ((c / W) | 0)) continue;
      if (!wall[n] && !out[n]) { out[n] = 1; st.push(n); }
    }
  }
  const floor = [];
  for (let i = 0; i < W * H; i++) if (!wall[i] && !out[i]) floor.push(i);
  return { W, H, wall, out, floor, D };
}

// Backward search from the solved position. Returns every reachable position in breadth-first order,
// so queue[n].depth is the minimum number of pushes that solves queue[n].
function solveReverse(room, goals) {
  const { W, H, floor, D } = room;
  const N = W * H;
  const isFloor = new Uint8Array(N);
  for (const f of floor) isFloor[f] = 1;

  // cells the keeper can walk to from `from`; `min` names the region
  function region(boxSet, from) {
    const cells = [from];
    const mark = new Uint8Array(N);
    mark[from] = 1;
    let min = from;
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h];
      for (const d of D) {
        const n = c + d;
        if (isFloor[n] && !mark[n] && !boxSet[n]) { mark[n] = 1; cells.push(n); if (n < min) min = n; }
      }
    }
    return { cells, mark, min };
  }

  const states = new Map();   // "crates|region" -> state
  const queue = [];
  const g = goals.slice().sort((a, b) => a - b);
  const bs = new Uint8Array(N);
  for (const b of g) bs[b] = 1;

  // the solved position counts once for every region the keeper could end in
  const done = new Uint8Array(N);
  for (const f of floor) {
    if (bs[f] || done[f]) continue;
    const r = region(bs, f);
    for (const c of r.cells) done[c] = 1;
    const s = { boxes: g, canon: r.min, depth: 0, parent: null, push: null };
    states.set(g.join(',') + '|' + r.min, s);
    queue.push(s);
  }

  for (let h = 0; h < queue.length; h++) {
    const s = queue[h];
    if (states.size > STATE_LIMIT) return null;
    const bset = new Uint8Array(N);
    for (const b of s.boxes) bset[b] = 1;
    const r = region(bset, s.canon);
    for (const p of r.cells) for (const d of D) {
      const b = p - d;                                  // a crate right behind the keeper
      if (!bset[b]) continue;
      const t = p + d;                                  // the keeper steps forward, the crate follows into p
      if (!isFloor[t] || bset[t]) continue;
      const nb = s.boxes.map(x => x === b ? p : x).sort((a, c) => a - c);
      const nset = new Uint8Array(N);
      for (const x of nb) nset[x] = 1;
      const nr = region(nset, t);
      const key = nb.join(',') + '|' + nr.min;
      if (states.has(key)) continue;
      // played forwards, this pull is a push of the crate at p in direction -d
      const ns = { boxes: nb, canon: nr.min, depth: s.depth + 1, parent: s, push: { from: p, dir: -d } };
      states.set(key, ns);
      queue.push(ns);
    }
  }
  return { queue, region, isFloor };
}

// Shortest walk between two cells that avoids the crates; returns the steps as cell offsets.
function walk(room, isFloor, boxes, from, to) {
  const N = room.W * room.H, prev = new Int32Array(N).fill(-2), bset = new Uint8Array(N);
  for (const b of boxes) bset[b] = 1;
  const q = [from];
  prev[from] = -1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === to) break;
    for (const d of room.D) {
      const n = c + d;
      if (isFloor[n] && !bset[n] && prev[n] === -2) { prev[n] = c; q.push(n); }
    }
  }
  if (prev[to] === -2) return null;
  const path = [];
  let c = to;
  while (prev[c] !== -1) { path.unshift(c - prev[c]); c = prev[c]; }
  return path;
}

// Step letters: u d l r for a walk, U D L R for a push.
function letter(room, d, push) {
  const m = d === 1 ? 'r' : d === -1 ? 'l' : d === room.W ? 'd' : 'u';
  return push ? m.toUpperCase() : m;
}

// Writes a position out as a level in XSB notation, with a solution that uses the minimum pushes.
function build(room, goals, state, res, rand) {
  const N = room.W * room.H, bset = new Uint8Array(N);
  for (const b of state.boxes) bset[b] = 1;
  // the keeper starts somewhere in the position's region, off the marked spots when possible
  const reg = res.region(bset, state.canon).cells.filter(c => !goals.includes(c));
  const all = res.region(bset, state.canon).cells;
  const start = (reg.length ? reg : all)[(rand() * (reg.length ? reg.length : all.length)) | 0];

  // following the parents back to the solved position gives the pushes in playing order
  let sol = '', pos = start, boxes = state.boxes.slice();
  for (let s = state; s.parent; s = s.parent) {
    const { from, dir } = s.push;
    const stand = from - dir;
    const w = walk(room, res.isFloor, boxes, pos, stand);
    if (!w) throw new Error('walk failed');
    for (const d of w) sol += letter(room, d, false);
    sol += letter(room, dir, true);
    boxes = boxes.map(x => x === from ? from + dir : x);
    pos = from;
  }

  const rows = [];
  for (let y = 0; y < room.H; y++) {
    let r = '';
    for (let x = 0; x < room.W; x++) {
      const i = y * room.W + x;
      const isG = goals.includes(i), isB = state.boxes.includes(i);
      r += room.wall[i] ? '#' : i === start ? (isG ? '+' : '@') : isB ? (isG ? '*' : '$') : isG ? '.' : ' ';
    }
    rows.push(r.replace(/\s+$/, ''));
  }
  return { rows, par: state.depth, solution: sol };
}

// Step 1: for every room and crate count, find the placements of marked spots that search deepest.
function explore() {
  const rand = rng(EXPLORE_SEED);
  const best = {};
  for (const name of Object.keys(ROOMS)) for (const k of [2, 3, 4]) {
    const room = prep(ROOMS[name]);
    const list = [];
    for (let a = 0; a < PLACEMENTS[k]; a++) {
      const pool = room.floor.slice();
      const goals = [];
      while (goals.length < k) { const i = (rand() * pool.length) | 0; goals.push(pool.splice(i, 1)[0]); }
      const res = solveReverse(room, goals);
      if (!res) continue;
      list.push({ depth: res.queue[res.queue.length - 1].depth, goals });
    }
    list.sort((a, b) => b.depth - a.depth);
    best[name + '|' + k] = list.slice(0, KEEP);
  }
  return best;
}

// Step 2: for every planned level, pick a position at the wanted depth.
function pick(explored) {
  const rand = rng(PICK_SEED);
  const levels = [];
  PLAN.forEach(([name, k, target], li) => {
    const room = prep(ROOMS[name]);
    let best = null;
    for (const entry of explored[name + '|' + k]) {
      if (entry.depth < target) continue;
      const res = solveReverse(room, entry.goals);
      // prefer positions with no crate on a spot; allow one only when nothing else has turned up
      let cands = res.queue.filter(s => s.depth === target && s.boxes.every(b => !entry.goals.includes(b)));
      if (!cands.length && !best) cands = res.queue.filter(s => s.depth === target && s.boxes.filter(b => entry.goals.includes(b)).length <= 1);
      for (let t = 0; t < Math.min(40, cands.length); t++) {
        const st = cands[(rand() * cands.length) | 0];
        // score = how far the crates sit from the nearest spot
        let score = 0;
        for (const b of st.boxes) {
          score += Math.min(...entry.goals.map(g2 => Math.abs((b % room.W) - (g2 % room.W)) + Math.abs(((b / room.W) | 0) - ((g2 / room.W) | 0))));
        }
        if (!best || score > best.score) best = { score, lvl: build(room, entry.goals, st, res, rand), max: entry.depth };
      }
    }
    if (!best) throw new Error('no level found for entry ' + (li + 1));
    levels.push({ room: name, boxes: k, par: best.lvl.par, rows: best.lvl.rows, solution: best.lvl.solution });
  });
  return levels;
}

function main() {
  const levels = pick(explore());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(levels, null, 1));
    return;
  }
  levels.forEach((l, i) => {
    console.log(`Level ${i + 1}: room ${l.room}, ${l.boxes} crates, minimum ${l.par} pushes, solution of ${l.solution.length} moves`);
    console.log(l.rows.join('\n'));
    console.log(l.solution + '\n');
  });
}

if (require.main === module) main();
module.exports = { ROOMS, PLAN, explore, pick };
