/**
 * Runtime trail, vector, POI, and race data API (owned by @traildata).
 * Implements PLAN.md loadTrailData(engine) contract with:
 * - Fast 100m spatial grid for zero-GC per-frame nearest(x, z, maxDist)
 * - Lazy-loaded full-region trail graph with A* route(from, to)
 * - Tile-chunked vector streaming via loadArea(x, z, radius) emitting 'data:chunk'
 */

const CELL_SIZE = 100;
const GRID_OFFSET = 2048;
const GRID_STRIDE = 4096;

function cellKey(cx, cz) {
  return (cx + GRID_OFFSET) * GRID_STRIDE + (cz + GRID_OFFSET);
}

class MinHeap {
  constructor() {
    this.items = [];
  }
  push(node, f) {
    const items = this.items;
    items.push({ node, f });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].f <= items[i].f) break;
      const tmp = items[p];
      items[p] = items[i];
      items[i] = tmp;
      i = p;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      while (true) {
        let best = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && items[l].f < items[best].f) best = l;
        if (r < n && items[r].f < items[best].f) best = r;
        if (best === i) break;
        const tmp = items[best];
        items[best] = items[i];
        items[i] = tmp;
        i = best;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

export async function loadTrailData(engine) {
  const rawBase = engine?.assetsBase || import.meta.env.BASE_URL || './';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const vecBase = `${base}data/vector/`;

  async function fetchJson(relPath) {
    const res = await fetch(`${vecBase}${relPath}`);
    if (!res.ok) throw new Error(`Failed to fetch ${vecBase}${relPath}: ${res.status}`);
    return res.json();
  }

  const [manifest, poisData, racesRaw] = await Promise.all([
    fetchJson('manifest.json').catch(() => ({ chunks: [], chunkZoom: 13 })),
    fetchJson('pois.json').catch(() => []),
    fetchJson('races.json').catch(() => []),
  ]);

  const pois = Array.isArray(poisData) ? poisData : poisData?.pois || [];
  const races = (Array.isArray(racesRaw) ? racesRaw : racesRaw?.races || []).map((r) => ({
    ...r,
    line: r.line instanceof Float32Array ? r.line : new Float32Array(r.line || []),
  }));

  // Live collections populated incrementally by loadArea()
  const trails = [];
  const waterways = [];
  const lakes = [];
  const waterfalls = [];
  const buildings = [];
  const aerialways = [];
  const skiRuns = [];

  const seenTrail = new Set();
  const seenWaterway = new Set();
  const seenLake = new Set();
  const seenWaterfall = new Set();
  const seenBuilding = new Set();
  const seenAerialway = new Set();
  const seenSkiRun = new Set();

  // Spatial hash grid for fast per-frame nearest()
  const grid = new Map();
  const segments = []; // { x0, z0, dx, dz, invLenSq, tx, tz, edge }
  const segStamp = [];
  let queryStamp = 0;

  function indexTrailEdge(edge) {
    const c = edge.coords;
    if (!c || c.length < 6) return;
    for (let i = 0; i <= c.length - 6; i += 3) {
      const x0 = c[i];
      const z0 = c[i + 2];
      const x1 = c[i + 3];
      const z1 = c[i + 5];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-4) continue;
      const len = Math.sqrt(lenSq);
      const segId = segments.length;
      segments.push({
        x0,
        z0,
        dx,
        dz,
        invLenSq: 1 / lenSq,
        tx: dx / len,
        tz: dz / len,
        edge,
      });
      segStamp.push(0);

      const minCx = Math.floor(Math.min(x0, x1) / CELL_SIZE);
      const maxCx = Math.floor(Math.max(x0, x1) / CELL_SIZE);
      const minCz = Math.floor(Math.min(z0, z1) / CELL_SIZE);
      const maxCz = Math.floor(Math.max(z0, z1) / CELL_SIZE);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const k = cellKey(cx, cz);
          let bucket = grid.get(k);
          if (!bucket) {
            bucket = [];
            grid.set(k, bucket);
          }
          bucket.push(segId);
        }
      }
    }
  }

  /**
   * Find nearest trail/road/track/path within maxDist meters.
   * Designed to be called every frame with minimal allocation.
   */
  function nearest(x, z, maxDist = 50) {
    if (segments.length === 0) return null;
    const stamp = ++queryStamp;
    const minCx = Math.floor((x - maxDist) / CELL_SIZE);
    const maxCx = Math.floor((x + maxDist) / CELL_SIZE);
    const minCz = Math.floor((z - maxDist) / CELL_SIZE);
    const maxCz = Math.floor((z + maxDist) / CELL_SIZE);

    let bestDistSq = maxDist * maxDist;
    let bestSeg = null;
    let bestPx = 0;
    let bestPz = 0;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = grid.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const segId = bucket[i];
          if (segStamp[segId] === stamp) continue;
          segStamp[segId] = stamp;

          const s = segments[segId];
          let t = ((x - s.x0) * s.dx + (z - s.z0) * s.dz) * s.invLenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;

          const px = s.x0 + s.dx * t;
          const pz = s.z0 + s.dz * t;
          const ex = x - px;
          const ez = z - pz;
          const dSq = ex * ex + ez * ez;
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestSeg = s;
            bestPx = px;
            bestPz = pz;
          }
        }
      }
    }

    if (!bestSeg) return null;
    const e = bestSeg.edge;
    return {
      dist: Math.sqrt(bestDistSq),
      x: bestPx,
      z: bestPz,
      tx: bestSeg.tx,
      tz: bestSeg.tz,
      edgeId: e.id,
      kind: e.kind,
      name: e.name || '',
      difficulty: e.difficulty || 'moderate',
    };
  }

  // Lazy-loaded full trail graph for synchronous A* route()
  let graph = null;
  let graphPromise = null;
  const KIND_COST = [1.0, 1.05, 1.15, 1.55]; // trail, path, track, road

  function buildGraphRuntime(raw) {
    const nodes = new Float32Array(raw.nodes || []);
    const nodeCount = Math.floor(nodes.length / 2);
    const adj = Array.from({ length: nodeCount }, () => []);
    const edges = raw.edges || [];
    const nodeGrid = new Map();
    const NODE_CELL = 500;

    for (let i = 0; i < nodeCount; i++) {
      const nx = nodes[i * 2];
      const nz = nodes[i * 2 + 1];
      const k = cellKey(Math.floor(nx / NODE_CELL), Math.floor(nz / NODE_CELL));
      let arr = nodeGrid.get(k);
      if (!arr) {
        arr = [];
        nodeGrid.set(k, arr);
      }
      arr.push(i);
    }

    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const u = e[0];
      const v = e[1];
      const len = e[2];
      const kindIdx = e[3];
      const weight = len * (KIND_COST[kindIdx] ?? 1.2);
      adj[u].push({ to: v, edgeIdx: ei, weight, rev: false });
      adj[v].push({ to: u, edgeIdx: ei, weight, rev: true });
    }

    return { nodes, nodeCount, adj, edges, nodeGrid, NODE_CELL };
  }

  function ensureGraph() {
    if (graph || graphPromise) return graphPromise;
    graphPromise = fetchJson('graph.json')
      .then((raw) => {
        graph = buildGraphRuntime(raw);
        return graph;
      })
      .catch(() => null);
    return graphPromise;
  }

  function nearestGraphNode(x, z, maxDist = 2500) {
    const { nodes, nodeGrid, NODE_CELL } = graph;
    const radCells = Math.ceil(maxDist / NODE_CELL);
    const cx0 = Math.floor(x / NODE_CELL);
    const cz0 = Math.floor(z / NODE_CELL);
    let best = -1;
    let bestD2 = maxDist * maxDist;

    for (let cx = cx0 - radCells; cx <= cx0 + radCells; cx++) {
      for (let cz = cz0 - radCells; cz <= cz0 + radCells; cz++) {
        const arr = nodeGrid.get(cellKey(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const nid = arr[i];
          const dx = nodes[nid * 2] - x;
          const dz = nodes[nid * 2 + 1] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = nid;
          }
        }
      }
    }
    return best;
  }

  function route(fromNodeOrXZ, toNodeOrXZ) {
    if (!fromNodeOrXZ || !toNodeOrXZ) return [];
    const fx = typeof fromNodeOrXZ === 'number' && graph ? graph.nodes[fromNodeOrXZ * 2] : (fromNodeOrXZ.x ?? 0);
    const fz = typeof fromNodeOrXZ === 'number' && graph ? graph.nodes[fromNodeOrXZ * 2 + 1] : (fromNodeOrXZ.z ?? 0);
    const tx = typeof toNodeOrXZ === 'number' && graph ? graph.nodes[toNodeOrXZ * 2] : (toNodeOrXZ.x ?? 0);
    const tz = typeof toNodeOrXZ === 'number' && graph ? graph.nodes[toNodeOrXZ * 2 + 1] : (toNodeOrXZ.z ?? 0);

    if (!graph) {
      ensureGraph();
      return [
        { x: fx, z: fz },
        { x: tx, z: tz },
      ];
    }

    const startId = typeof fromNodeOrXZ === 'number' ? fromNodeOrXZ : nearestGraphNode(fx, fz);
    const goalId = typeof toNodeOrXZ === 'number' ? toNodeOrXZ : nearestGraphNode(tx, tz);
    if (startId < 0 || goalId < 0) {
      return [
        { x: fx, z: fz },
        { x: tx, z: tz },
      ];
    }
    if (startId === goalId) {
      return [
        { x: fx, z: fz },
        { x: tx, z: tz },
      ];
    }

    const { nodes, nodeCount, adj, edges } = graph;
    const gx = nodes[goalId * 2];
    const gz = nodes[goalId * 2 + 1];

    const gScore = new Float64Array(nodeCount);
    gScore.fill(Infinity);
    const prevNode = new Int32Array(nodeCount);
    prevNode.fill(-1);
    const prevEdge = new Int32Array(nodeCount);
    prevEdge.fill(-1);
    const prevRev = new Uint8Array(nodeCount);
    const closed = new Uint8Array(nodeCount);

    gScore[startId] = 0;
    const heap = new MinHeap();
    heap.push(startId, Math.hypot(nodes[startId * 2] - gx, nodes[startId * 2 + 1] - gz));

    let found = false;
    let expansions = 0;
    const MAX_EXPANSIONS = 35000;

    while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
      const { node: u } = heap.pop();
      if (closed[u]) continue;
      if (u === goalId) {
        found = true;
        break;
      }
      closed[u] = 1;
      expansions++;

      const neighbors = adj[u];
      const gu = gScore[u];
      for (let i = 0; i < neighbors.length; i++) {
        const nb = neighbors[i];
        const v = nb.to;
        if (closed[v]) continue;
        const ng = gu + nb.weight;
        if (ng < gScore[v]) {
          gScore[v] = ng;
          prevNode[v] = u;
          prevEdge[v] = nb.edgeIdx;
          prevRev[v] = nb.rev ? 1 : 0;
          const h = Math.hypot(nodes[v * 2] - gx, nodes[v * 2 + 1] - gz);
          heap.push(v, ng + h);
        }
      }
    }

    if (!found) {
      return [
        { x: fx, z: fz },
        { x: tx, z: tz },
      ];
    }

    const chain = [];
    let cur = goalId;
    while (cur !== startId && prevNode[cur] !== -1) {
      chain.push({ edgeIdx: prevEdge[cur], rev: prevRev[cur] === 1 });
      cur = prevNode[cur];
    }
    chain.reverse();

    const poly = [{ x: fx, z: fz }];
    for (let i = 0; i < chain.length; i++) {
      const { edgeIdx, rev } = chain[i];
      const xz = edges[edgeIdx][5];
      const ptCount = xz.length / 2;
      if (!rev) {
        for (let j = 0; j < ptCount; j++) {
          const px = xz[j * 2];
          const pz = xz[j * 2 + 1];
          const last = poly[poly.length - 1];
          if (Math.hypot(px - last.x, pz - last.z) > 0.5) {
            poly.push({ x: px, z: pz });
          }
        }
      } else {
        for (let j = ptCount - 1; j >= 0; j--) {
          const px = xz[j * 2];
          const pz = xz[j * 2 + 1];
          const last = poly[poly.length - 1];
          if (Math.hypot(px - last.x, pz - last.z) > 0.5) {
            poly.push({ x: px, z: pz });
          }
        }
      }
    }
    const last = poly[poly.length - 1];
    if (Math.hypot(tx - last.x, tz - last.z) > 0.5) {
      poly.push({ x: tx, z: tz });
    }
    return poly;
  }

  // Tile chunk streaming
  const chunksList = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const loadedChunks = new Set();
  const inflightChunks = new Map();

  function ingestChunk(chunkMeta, data) {
    const added = {
      trails: [],
      waterways: [],
      lakes: [],
      waterfalls: [],
      buildings: [],
      aerialways: [],
      skiRuns: [],
    };

    if (Array.isArray(data.trails)) {
      for (let i = 0; i < data.trails.length; i++) {
        const t = data.trails[i];
        if (seenTrail.has(t.id)) continue;
        seenTrail.add(t.id);
        const item = {
          ...t,
          coords: t.coords instanceof Float32Array ? t.coords : new Float32Array(t.coords),
        };
        trails.push(item);
        added.trails.push(item);
        indexTrailEdge(item);
      }
    }

    if (Array.isArray(data.waterways)) {
      for (let i = 0; i < data.waterways.length; i++) {
        const w = data.waterways[i];
        if (seenWaterway.has(w.id)) continue;
        seenWaterway.add(w.id);
        const item = {
          ...w,
          coords: w.coords instanceof Float32Array ? w.coords : new Float32Array(w.coords),
        };
        waterways.push(item);
        added.waterways.push(item);
      }
    }

    if (Array.isArray(data.lakes)) {
      for (let i = 0; i < data.lakes.length; i++) {
        const l = data.lakes[i];
        if (seenLake.has(l.id)) continue;
        seenLake.add(l.id);
        const item = {
          ...l,
          coords: l.coords instanceof Float32Array ? l.coords : new Float32Array(l.coords),
        };
        lakes.push(item);
        added.lakes.push(item);
      }
    }

    if (Array.isArray(data.waterfalls)) {
      for (let i = 0; i < data.waterfalls.length; i++) {
        const wf = data.waterfalls[i];
        if (seenWaterfall.has(wf.id)) continue;
        seenWaterfall.add(wf.id);
        waterfalls.push(wf);
        added.waterfalls.push(wf);
      }
    }

    if (Array.isArray(data.buildings)) {
      for (let i = 0; i < data.buildings.length; i++) {
        const b = data.buildings[i];
        if (seenBuilding.has(b.id)) continue;
        seenBuilding.add(b.id);
        const item = {
          ...b,
          coords: b.coords instanceof Float32Array ? b.coords : new Float32Array(b.coords),
        };
        buildings.push(item);
        added.buildings.push(item);
      }
    }

    if (Array.isArray(data.aerialways)) {
      for (let i = 0; i < data.aerialways.length; i++) {
        const aw = data.aerialways[i];
        if (seenAerialway.has(aw.id)) continue;
        seenAerialway.add(aw.id);
        const item = {
          ...aw,
          coords: aw.coords instanceof Float32Array ? aw.coords : new Float32Array(aw.coords),
        };
        aerialways.push(item);
        added.aerialways.push(item);
      }
    }

    if (Array.isArray(data.skiRuns)) {
      for (let i = 0; i < data.skiRuns.length; i++) {
        const sr = data.skiRuns[i];
        if (seenSkiRun.has(sr.id)) continue;
        seenSkiRun.add(sr.id);
        const item = {
          ...sr,
          coords: sr.coords instanceof Float32Array ? sr.coords : new Float32Array(sr.coords),
        };
        skiRuns.push(item);
        added.skiRuns.push(item);
      }
    }

    engine?.events?.emit?.('data:chunk', {
      tx: chunkMeta.tx,
      ty: chunkMeta.ty,
      added,
    });
    return added;
  }

  async function loadArea(x = 0, z = 0, radius = 4000) {
    ensureGraph();
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;

    const promises = [];
    for (let i = 0; i < chunksList.length; i++) {
      const c = chunksList[i];
      const [bMinX, bMinZ, bMaxX, bMaxZ] = c.bounds;
      if (bMaxX < minX || bMinX > maxX || bMaxZ < minZ || bMinZ > maxZ) continue;
      const key = `${c.tx}_${c.ty}`;
      if (loadedChunks.has(key)) continue;

      let p = inflightChunks.get(key);
      if (!p) {
        p = fetchJson(c.file)
          .then((data) => {
            loadedChunks.add(key);
            inflightChunks.delete(key);
            return ingestChunk(c, data);
          })
          .catch((err) => {
            inflightChunks.delete(key);
            console.warn(`Failed loading vector chunk ${c.file}:`, err);
            return null;
          });
        inflightChunks.set(key, p);
      }
      promises.push(p);
    }

    if (promises.length === 0) return { added: null };
    const results = await Promise.all(promises);
    const totalAdded = {
      trails: [],
      waterways: [],
      lakes: [],
      waterfalls: [],
      buildings: [],
      aerialways: [],
      skiRuns: [],
    };
    for (const r of results) {
      if (!r) continue;
      for (const k of Object.keys(totalAdded)) {
        if (r[k]?.length) totalAdded[k].push(...r[k]);
      }
    }
    return { added: totalAdded };
  }

  return {
    nearest,
    route,
    pois,
    races,
    trails,
    waterways,
    lakes,
    waterfalls,
    buildings,
    aerialways,
    skiRuns,
    loadArea,
    manifest,
  };
}
