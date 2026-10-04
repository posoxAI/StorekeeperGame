#!/usr/bin/env node
// Checks the levels that ship in index.html with a solver that shares no code with the generator.
//
// Usage:
//   node tools/verify-levels.js
//
// For every level it searches forwards, by pushing, from the starting position and reports the
// minimum number of pushes. The run fails if a level cannot be solved or if that minimum differs
// from the "par" stored in the game.

'use strict';

const fs = require('fs');
const path = require('path');

// Reads the LEVELS array out of the game file.
function readLevels(file) {
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/var LEVELS = (\[[\s\S]*?\n  \]);/);
  if (!m) throw new Error('LEVELS array not found in ' + file);
  return Function('"use strict"; return ' + m[1] + ';')();
}

function parse(rows) {
  const walls = new Set(), goals = new Set(), boxes = [];
  let keeper = null;
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const key = x + ',' + y;
    if (c === '#') walls.add(key);
    if (c === '.' || c === '+' || c === '*') goals.add(key);
    if (c === '$' || c === '*') boxes.push(key);
    if (c === '@' || c === '+') keeper = key;
  }));
  return { walls, goals, boxes, keeper };
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const at = (x, y) => x + ',' + y;
const xy = key => key.split(',').map(Number);

// Breadth-first search over pushes. Returns the minimum number of pushes, or null if unsolvable.
function minimumPushes(rows) {
  const { walls, goals, boxes, keeper } = parse(rows);
  if (!keeper) throw new Error('level has no keeper');
  if (boxes.length !== goals.size) throw new Error('crates and marked spots differ in number');

  // every cell the keeper can walk to, and the smallest of them as the name of the region
  function region(boxSet, from) {
    const seen = new Set([from]), queue = [from];
    for (let h = 0; h < queue.length; h++) {
      const [x, y] = xy(queue[h]);
      for (const [dx, dy] of STEPS) {
        const n = at(x + dx, y + dy);
        if (!walls.has(n) && !boxSet.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    return seen;
  }
  const nameOf = cells => [...cells].sort()[0];
  const keyOf = (boxList, regionName) => boxList.slice().sort().join(';') + '|' + regionName;
  const solved = boxList => boxList.every(b => goals.has(b));

  const startRegion = region(new Set(boxes), keeper);
  const seen = new Set([keyOf(boxes, nameOf(startRegion))]);
  let frontier = [{ boxes, keeper }];
  for (let pushes = 0; frontier.length; pushes++) {
    const next = [];
    for (const state of frontier) {
      if (solved(state.boxes)) return pushes;
      const boxSet = new Set(state.boxes);
      const reach = region(boxSet, state.keeper);
      for (const b of state.boxes) {
        const [bx, by] = xy(b);
        for (const [dx, dy] of STEPS) {
          const stand = at(bx - dx, by - dy), to = at(bx + dx, by + dy);
          if (!reach.has(stand) || walls.has(to) || boxSet.has(to)) continue;
          const moved = state.boxes.map(c => c === b ? to : c);
          const key = keyOf(moved, nameOf(region(new Set(moved), b)));
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ boxes: moved, keeper: b });
        }
      }
    }
    frontier = next;
  }
  return null;
}

function main() {
  const file = path.join(__dirname, '..', 'index.html');
  const levels = readLevels(file);
  let failed = 0;
  levels.forEach((level, i) => {
    const found = minimumPushes(level.rows);
    const ok = found === level.par;
    if (!ok) failed++;
    console.log(`Level ${String(i + 1).padStart(2)}: stored minimum ${String(level.par).padStart(2)}, solver found ${found === null ? 'no solution' : String(found).padStart(2)}  ${ok ? 'ok' : 'MISMATCH'}`);
  });
  console.log(failed ? `${failed} of ${levels.length} levels failed` : `All ${levels.length} levels check out`);
  process.exit(failed ? 1 : 0);
}

main();
