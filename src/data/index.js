/**
 * Runtime trail, vector, POI, and race data API (owned by @traildata).
 * Implements PLAN.md loadTrailData(engine) contract with:
 * - Fast 100m spatial grid backed by flat Float32Array segments for zero-GC per-frame nearest()
 * - Concurrency-capped (6) + retry-hardened chunk fetching
 * - Sub-3ms mid-chunk time-sliced ingestion via engine.scheduler
 * - Bounded resident chunk cache (MAX_RESIDENT_CHUNKS = 56) preventing mobile OOM on 100mi runs / map pans
 * - Instant synchronous local-chunk A* route(from, to) + strictly on-demand graph.json fallback
 */

const CELL_SIZE = 100;
const GRID_OFFSET = 2048;
const GRID_STRIDE = 4096;
const KIND_COST_MAP = { trail: 1.0, path: 1.05, track: 1.15, road: 1.55 };
const KIND_COST_ARR = [1.0, 1.05, 1.15, 1.55];

const MAX_CONCURRENT_FETCHES = 6;
const MAX_RESIDENT_CHUNKS = 56; // ~21km x 21km active neighborhood (<8 MB worst-case RAM)
const INGEST_SLICE_BUDGET_MS = 2.8;
const SEG_STRIDE = 7; // x0, z0, dx, dz, invLenSq, tx, tz

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

function computeCoordsBBoxXZ(coords) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i];
    const z = coords[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

function runAStarGraph(g, startId, goalId, fx, fz, tx, tz, maxExpansions = 35000) {
  const { nodes, nodeCount, adj, getEdgePoints } = g;
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

  while (heap.size > 0 && expansions < maxExpansions) {
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

  if (!found) return null;

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
    getEdgePoints(edgeIdx, rev, poly);
  }
  const last = poly[poly.length - 1];
  if (Math.hypot(tx - last.x, tz - last.z) > 0.5) {
    poly.push({ x: tx, z: tz });
  }
  return poly;
}

export async function loadTrailData(engine) {
  const rawBase = engine?.assetsBase || import.meta.env.BASE_URL || './';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const vecBase = `${base}data/vector/`;

  // Concurrency-capped fetch semaphore + retry with backoff (no retry on HTTP 404)
  let activeFetches = 0;
  const fetchWaiters = [];

  function acquireFetchSlot() {
    if (activeFetches < MAX_CONCURRENT_FETCHES) {
      activeFetches++;
      return Promise.resolve();
    }
    return new Promise((resolve) => fetchWaiters.push(resolve));
  }

  function releaseFetchSlot() {
    if (fetchWaiters.length > 0) {
      const next = fetchWaiters.shift();
      next();
    } else {
      activeFetches = Math.max(0, activeFetches - 1);
    }
  }

  async function fetchJson(relPath, maxRetries = 2) {
    await acquireFetchSlot();
    try {
      const url = `${vecBase}${relPath}`;
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await fetch(url);
          if (res.status === 404) {
            throw Object.assign(new Error(`Not found: ${url}`), { noRetry: true });
          }
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
          }
          return await res.json();
        } catch (err) {
          lastErr = err;
          if (err?.noRetry || attempt >= maxRetries) break;
          await new Promise((r) => setTimeout(r, attempt === 0 ? 150 : 400));
        }
      }
      throw lastErr;
    } finally {
      releaseFetchSlot();
    }
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

  // Live collections populated incrementally by loadArea() and bounded by LRU eviction
  const trails = [];
  const waterways = [];
  const lakes = [];
  const waterfalls = [];
  const buildings = [];
  const aerialways = [];
  const skiRuns = [];

  // Reference count per deduplicated feature ID across resident chunks
  const refCounts = {
    trails: new Map(),
    waterways: new Map(),
    lakes: new Map(),
    waterfalls: new Map(),
    buildings: new Map(),
    aerialways: new Map(),
    skiRuns: new Map(),
  };

  const CAT_ARRAYS = { trails, waterways, lakes, waterfalls, buildings, aerialways, skiRuns };

  // Flat TypedArray storage for 100m spatial grid segments (avoids per-segment JS object overhead)
  let segCapacity = 4096;
  let segCount = 0;
  let segData = new Float32Array(segCapacity * SEG_STRIDE);
  let segStamp = new Uint32Array(segCapacity);
  const segEdges = [];
  const grid = new Map();
  let queryStamp = 0;
  let spatialIndexDirty = false;

  function ensureSegCapacity(needed) {
    if (needed <= segCapacity) return;
    while (segCapacity < needed) segCapacity *= 2;
    const nextData = new Float32Array(segCapacity * SEG_STRIDE);
    nextData.set(segData.subarray(0, segCount * SEG_STRIDE));
    segData = nextData;
    const nextStamp = new Uint32Array(segCapacity);
    nextStamp.set(segStamp.subarray(0, segCount));
    segStamp = nextStamp;
  }

  // Dynamic local graph built from resident trail chunks for instant zero-fetch route()
  const localEndpointMap = new Map();
  const localNodesArr = [];
  const localAdj = [];
  const localEdges = [];
  const localNodeGrid = new Map();
  const LOCAL_NODE_CELL = 400;

  function getOrCreateLocalNode(x, z) {
    const qk = `${Math.round(x * 2)}_${Math.round(z * 2)}`;
    let nid = localEndpointMap.get(qk);
    if (nid !== undefined) return nid;
    nid = localAdj.length;
    localEndpointMap.set(qk, nid);
    localNodesArr.push(x, z);
    localAdj.push([]);
    const ck = cellKey(Math.floor(x / LOCAL_NODE_CELL), Math.floor(z / LOCAL_NODE_CELL));
    let bucket = localNodeGrid.get(ck);
    if (!bucket) {
      bucket = [];
      localNodeGrid.set(ck, bucket);
    }
    bucket.push(nid);
    return nid;
  }

  function indexTrailEdge(edge) {
    const c = edge.coords;
    if (!c || c.length < 6) return;

    const u = getOrCreateLocalNode(c[0], c[2]);
    const v = getOrCreateLocalNode(c[c.length - 3], c[c.length - 1]);
    if (u !== v) {
      const ei = localEdges.length;
      localEdges.push(c);
      const len = edge.lengthM || Math.hypot(c[c.length - 3] - c[0], c[c.length - 1] - c[2]);
      const weight = len * (KIND_COST_MAP[edge.kind] ?? 1.2);
      localAdj[u].push({ to: v, edgeIdx: ei, weight, rev: false });
      localAdj[v].push({ to: u, edgeIdx: ei, weight, rev: true });
    }

    const maxNewSegs = Math.floor(c.length / 3) - 1;
    ensureSegCapacity(segCount + maxNewSegs);

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
      const segId = segCount++;
      const baseOff = segId * SEG_STRIDE;
      segData[baseOff] = x0;
      segData[baseOff + 1] = z0;
      segData[baseOff + 2] = dx;
      segData[baseOff + 3] = dz;
      segData[baseOff + 4] = 1 / lenSq;
      segData[baseOff + 5] = dx / len;
      segData[baseOff + 6] = dz / len;
      segStamp[segId] = 0;
      segEdges[segId] = edge;

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

  function rebuildSpatialIndex() {
    segCount = 0;
    segEdges.length = 0;
    grid.clear();
    localEndpointMap.clear();
    localNodesArr.length = 0;
    localAdj.length = 0;
    localEdges.length = 0;
    localNodeGrid.clear();
    queryStamp = 0;
    for (let i = 0; i < trails.length; i++) {
      indexTrailEdge(trails[i]);
    }
    spatialIndexDirty = false;
  }

  /**
   * Find nearest trail/road/track/path within maxDist meters.
   * Designed to be called every frame with minimal allocation.
   */
  function nearest(x, z, maxDist = 50) {
    if (spatialIndexDirty) rebuildSpatialIndex();
    if (segCount === 0) return null;
    if (queryStamp >= 0x7ffffff0) {
      segStamp.fill(0, 0, segCount);
      queryStamp = 0;
    }
    const stamp = ++queryStamp;
    const minCx = Math.floor((x - maxDist) / CELL_SIZE);
    const maxCx = Math.floor((x + maxDist) / CELL_SIZE);
    const minCz = Math.floor((z - maxDist) / CELL_SIZE);
    const maxCz = Math.floor((z + maxDist) / CELL_SIZE);

    let bestDistSq = maxDist * maxDist;
    let bestSegId = -1;
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

          const baseOff = segId * SEG_STRIDE;
          const x0 = segData[baseOff];
          const z0 = segData[baseOff + 1];
          const dx = segData[baseOff + 2];
          const dz = segData[baseOff + 3];
          let t = ((x - x0) * dx + (z - z0) * dz) * segData[baseOff + 4];
          if (t < 0) t = 0;
          else if (t > 1) t = 1;

          const px = x0 + dx * t;
          const pz = z0 + dz * t;
          const ex = x - px;
          const ez = z - pz;
          const dSq = ex * ex + ez * ez;
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestSegId = segId;
            bestPx = px;
            bestPz = pz;
          }
        }
      }
    }

    if (bestSegId < 0) return null;
    const e = segEdges[bestSegId];
    const baseOff = bestSegId * SEG_STRIDE;
    return {
      dist: Math.sqrt(bestDistSq),
      x: bestPx,
      z: bestPz,
      tx: segData[baseOff + 5],
      tz: segData[baseOff + 6],
      edgeId: e.id,
      kind: e.kind,
      name: e.name || '',
      difficulty: e.difficulty || 'moderate',
    };
  }

  // Strictly on-demand full-region trail graph for long-range A* route()
  let graph = null;
  let graphPromise = null;

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
      const weight = len * (KIND_COST_ARR[kindIdx] ?? 1.2);
      adj[u].push({ to: v, edgeIdx: ei, weight, rev: false });
      adj[v].push({ to: u, edgeIdx: ei, weight, rev: true });
    }

    return {
      nodes,
      nodeCount,
      adj,
      edges,
      nodeGrid,
      NODE_CELL,
      getEdgePoints(edgeIdx, rev, poly) {
        const xz = edges[edgeIdx][5];
        const ptCount = xz.length / 2;
        if (!rev) {
          for (let j = 0; j < ptCount; j++) {
            const px = xz[j * 2];
            const pz = xz[j * 2 + 1];
            const last = poly[poly.length - 1];
            if (Math.hypot(px - last.x, pz - last.z) > 0.5) poly.push({ x: px, z: pz });
          }
        } else {
          for (let j = ptCount - 1; j >= 0; j--) {
            const px = xz[j * 2];
            const pz = xz[j * 2 + 1];
            const last = poly[poly.length - 1];
            if (Math.hypot(px - last.x, pz - last.z) > 0.5) poly.push({ x: px, z: pz });
          }
        }
      },
    };
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

  function findNearestGridNode(nodes, nodeGrid, cellSize, x, z, maxDist = 2500) {
    const radCells = Math.ceil(maxDist / cellSize);
    const cx0 = Math.floor(x / cellSize);
    const cz0 = Math.floor(z / cellSize);
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
    if (spatialIndexDirty) rebuildSpatialIndex();

    const fx = typeof fromNodeOrXZ === 'number' && graph ? graph.nodes[fromNodeOrXZ * 2] : (fromNodeOrXZ.x ?? 0);
    const fz = typeof fromNodeOrXZ === 'number' && graph ? graph.nodes[fromNodeOrXZ * 2 + 1] : (fromNodeOrXZ.z ?? 0);
    const tx = typeof toNodeOrXZ === 'number' && graph ? graph.nodes[toNodeOrXZ * 2] : (toNodeOrXZ.x ?? 0);
    const tz = typeof toNodeOrXZ === 'number' && graph ? graph.nodes[toNodeOrXZ * 2 + 1] : (toNodeOrXZ.z ?? 0);

    if (graph) {
      const startId = typeof fromNodeOrXZ === 'number' ? fromNodeOrXZ : findNearestGridNode(graph.nodes, graph.nodeGrid, graph.NODE_CELL, fx, fz);
      const goalId = typeof toNodeOrXZ === 'number' ? toNodeOrXZ : findNearestGridNode(graph.nodes, graph.nodeGrid, graph.NODE_CELL, tx, tz);
      if (startId >= 0 && goalId >= 0 && startId !== goalId) {
        const poly = runAStarGraph(graph, startId, goalId, fx, fz, tx, tz, 35000);
        if (poly) return poly;
      }
      return [{ x: fx, z: fz }, { x: tx, z: tz }];
    }

    if (localAdj.length > 0 && typeof fromNodeOrXZ !== 'number' && typeof toNodeOrXZ !== 'number') {
      const lStart = findNearestGridNode(localNodesArr, localNodeGrid, LOCAL_NODE_CELL, fx, fz, 1200);
      const lGoal = findNearestGridNode(localNodesArr, localNodeGrid, LOCAL_NODE_CELL, tx, tz, 1200);
      if (lStart >= 0 && lGoal >= 0 && lStart !== lGoal) {
        const localGraphView = {
          nodes: localNodesArr,
          nodeCount: localAdj.length,
          adj: localAdj,
          getEdgePoints(edgeIdx, rev, poly) {
            const c = localEdges[edgeIdx];
            const ptCount = Math.floor(c.length / 3);
            if (!rev) {
              for (let j = 0; j < ptCount; j++) {
                const px = c[j * 3];
                const pz = c[j * 3 + 2];
                const last = poly[poly.length - 1];
                if (Math.hypot(px - last.x, pz - last.z) > 0.5) poly.push({ x: px, z: pz });
              }
            } else {
              for (let j = ptCount - 1; j >= 0; j--) {
                const px = c[j * 3];
                const pz = c[j * 3 + 2];
                const last = poly[poly.length - 1];
                if (Math.hypot(px - last.x, pz - last.z) > 0.5) poly.push({ x: px, z: pz });
              }
            }
          },
        };
        const poly = runAStarGraph(localGraphView, lStart, lGoal, fx, fz, tx, tz, 8000);
        if (poly) return poly;
      }
    }

    ensureGraph();
    return [
      { x: fx, z: fz },
      { x: tx, z: tz },
    ];
  }

  // Tile chunk streaming with mid-chunk time-slicing + distance-weighted LRU eviction
  const chunksList = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const chunkRecords = new Map(); // key -> { key, tx, ty, cx, cz, bounds, lastUsed, idsByCat }
  const inflightChunks = new Map();
  let useClock = 1;
  let lastAnchorX = 0;
  let lastAnchorZ = 0;

  const CATEGORIES = ['trails', 'waterways', 'lakes', 'waterfalls', 'buildings', 'aerialways', 'skiRuns'];

  function evictExcessChunks() {
    if (chunkRecords.size <= MAX_RESIDENT_CHUNKS) return;
    let trailsRemoved = false;

    while (chunkRecords.size > MAX_RESIDENT_CHUNKS) {
      let victimKey = null;
      let victimScore = -Infinity;
      for (const [k, rec] of chunkRecords.entries()) {
        const dx = rec.cx - lastAnchorX;
        const dz = rec.cz - lastAnchorZ;
        const d2 = dx * dx + dz * dz;
        // Prefer evicting farthest + oldest chunks so chunkRecords.size never exceeds MAX_RESIDENT_CHUNKS
        const age = useClock - rec.lastUsed;
        const score = d2 + age * 1e6;
        if (score > victimScore) {
          victimScore = score;
          victimKey = k;
        }
      }
      if (!victimKey) break;

      const victim = chunkRecords.get(victimKey);
      chunkRecords.delete(victimKey);

      for (let ci = 0; ci < CATEGORIES.length; ci++) {
        const cat = CATEGORIES[ci];
        const ids = victim.idsByCat[cat];
        if (!ids || ids.length === 0) continue;
        const rcMap = refCounts[cat];
        let anyZero = false;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const next = (rcMap.get(id) || 1) - 1;
          if (next <= 0) {
            rcMap.delete(id);
            anyZero = true;
          } else {
            rcMap.set(id, next);
          }
        }
        if (anyZero) {
          const arr = CAT_ARRAYS[cat];
          let writeIdx = 0;
          for (let i = 0; i < arr.length; i++) {
            if (rcMap.has(arr[i].id)) {
              arr[writeIdx++] = arr[i];
            }
          }
          arr.length = writeIdx;
          if (cat === 'trails') trailsRemoved = true;
        }
      }

      engine?.events?.emit?.('data:evict', {
        tx: victim.tx,
        ty: victim.ty,
        bounds: victim.bounds,
      });
    }

    if (trailsRemoved) {
      spatialIndexDirty = true;
    }
  }

  function createChunkIngestor(chunkMeta, data) {
    const added = {
      trails: [],
      waterways: [],
      lakes: [],
      waterfalls: [],
      buildings: [],
      aerialways: [],
      skiRuns: [],
    };
    const idsByCat = {
      trails: [],
      waterways: [],
      lakes: [],
      waterfalls: [],
      buildings: [],
      aerialways: [],
      skiRuns: [],
    };

    let catIdx = 0;
    let itemIdx = 0;

    function stepSlice(budgetMs) {
      const start = performance.now();
      while (catIdx < CATEGORIES.length) {
        const cat = CATEGORIES[catIdx];
        const src = data[cat];
        if (!Array.isArray(src) || itemIdx >= src.length) {
          catIdx++;
          itemIdx = 0;
          continue;
        }

        const rcMap = refCounts[cat];
        const destArr = CAT_ARRAYS[cat];
        const addedArr = added[cat];
        const idList = idsByCat[cat];
        const isPoint = cat === 'waterfalls';

        while (itemIdx < src.length) {
          const rawItem = src[itemIdx++];
          const id = rawItem.id;
          idList.push(id);
          const prevRef = rcMap.get(id) || 0;
          rcMap.set(id, prevRef + 1);
          if (prevRef > 0) continue;

          let item;
          if (isPoint) {
            item = rawItem;
          } else {
            const coords =
              rawItem.coords instanceof Float32Array ? rawItem.coords : new Float32Array(rawItem.coords);
            item = {
              ...rawItem,
              coords,
              bbox: rawItem.bbox || computeCoordsBBoxXZ(coords),
            };
          }
          destArr.push(item);
          addedArr.push(item);
          if (cat === 'trails' && !spatialIndexDirty) {
            indexTrailEdge(item);
          }

          // Check slice budget every 16 items so even 1,250-building Telluride chunk never stalls >3ms
          if ((itemIdx & 15) === 0 && performance.now() - start >= budgetMs) {
            return true; // yield to next frame slice
          }
        }

        catIdx++;
        itemIdx = 0;
      }

      const key = `${chunkMeta.tx}_${chunkMeta.ty}`;
      const [bMinX, bMinZ, bMaxX, bMaxZ] = chunkMeta.bounds;
      chunkRecords.set(key, {
        key,
        tx: chunkMeta.tx,
        ty: chunkMeta.ty,
        cx: (bMinX + bMaxX) * 0.5,
        cz: (bMinZ + bMaxZ) * 0.5,
        bounds: chunkMeta.bounds,
        lastUsed: ++useClock,
        idsByCat,
      });

      engine?.events?.emit?.('data:chunk', {
        tx: chunkMeta.tx,
        ty: chunkMeta.ty,
        bounds: chunkMeta.bounds,
        added,
      });
      return false;
    }

    return { stepSlice, getAdded: () => added };
  }

  function scheduleChunkIngest(chunkMeta, data) {
    const ingestor = createChunkIngestor(chunkMeta, data);
    if (engine?.scheduler?.enqueue && engine?.getAppState?.() === 'playing') {
      return new Promise((resolve) => {
        engine.scheduler.enqueue(
          () => {
            const more = ingestor.stepSlice(INGEST_SLICE_BUDGET_MS);
            if (!more) resolve(ingestor.getAdded());
            return more;
          },
          { priority: 8, label: `vector:${chunkMeta.tx}_${chunkMeta.ty}` }
        );
      });
    }
    ingestor.stepSlice(Infinity);
    return Promise.resolve(ingestor.getAdded());
  }

  async function loadArea(x = 0, z = 0, radius = 4000) {
    lastAnchorX = x;
    lastAnchorZ = z;
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
      const existing = chunkRecords.get(key);
      if (existing) {
        existing.lastUsed = ++useClock;
        continue;
      }

      let p = inflightChunks.get(key);
      if (!p) {
        p = fetchJson(c.file)
          .then((data) => scheduleChunkIngest(c, data))
          .then((added) => {
            inflightChunks.delete(key);
            return added;
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
    evictExcessChunks();

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
