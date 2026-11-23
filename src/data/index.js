/**
 * STUB trail data module (owned by @traildata).
 * Implements PLAN.md loadTrailData(engine) contract with harmless placeholders.
 */
export async function loadTrailData() {
  const pois = [
    {
      id: 'telluride-town',
      name: 'Telluride Town Trailhead',
      kind: 'town',
      x: 0,
      z: 0,
      y: 2667,
      heading: Math.PI / 2,
      area: 'Telluride',
    },
    {
      id: 'bear-creek-th',
      name: 'Bear Creek Trailhead',
      kind: 'trailhead',
      x: 240,
      z: 420,
      y: 2705,
      heading: Math.PI,
      area: 'Telluride',
    },
  ];

  const races = [
    {
      id: 'rundola-stub',
      name: 'Rundola (Stub)',
      blurb: 'Up the gondola line. Real data coming soon from @traildata.',
      distanceMi: 2.3,
      gainFt: 1790,
      cutoffH: 3,
      start: { x: 0, z: 0 },
      finish: { x: 0, z: 800 },
      line: new Float32Array([0, 0, 0, 0, 800, 800]),
      checkpoints: [{ name: 'St. Sophia Station', d: 800, x: 0, z: 800 }],
      startTimeLocal: '08:00',
    },
  ];

  return {
    nearest() {
      return null;
    },
    route(from, to) {
      if (!from || !to) return [];
      return [
        { x: from.x || 0, z: from.z || 0 },
        { x: to.x || 0, z: to.z || 0 },
      ];
    },
    pois,
    races,
    waterways: [],
    lakes: [],
    waterfalls: [],
    buildings: [],
    aerialways: [],
    async loadArea() {
      return Promise.resolve();
    },
  };
}
