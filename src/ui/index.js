/**
 * STUB UI module (owned by @ui).
 * Implements PLAN.md createUI(engine, { trailData, game }) contract.
 */
export function createUI(engine, { trailData, game }) {
  const root = document.getElementById('ui-root') || document.body;
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:16px;left:16px;padding:12px 16px;border-radius:10px;background:rgba(16,24,32,0.82);color:#f3f5f7;font-size:14px;backdrop-filter:blur(6px);';
  banner.innerHTML = `
    <div style="font-weight:700;font-size:16px;margin-bottom:6px;">Telluride Trails</div>
    <div style="opacity:0.8;margin-bottom:10px;">Scaffold active (${trailData.pois.length} POIs, ${trailData.races.length} races)</div>
    <button id="stub-start-btn" style="padding:6px 12px;border:0;border-radius:6px;background:#e6532c;color:#fff;font-weight:600;cursor:pointer;">Start Free Run</button>
  `;
  root.appendChild(banner);

  const btn = banner.querySelector('#stub-start-btn');
  const onStart = () => {
    const startPoi = trailData.pois[0] || { x: 0, z: 0, heading: 0 };
    game.startFreeRun({ x: startPoi.x, z: startPoi.z, heading: startPoi.heading || 0 });
    engine.events.emit('ui:freerun', { x: startPoi.x, z: startPoi.z, heading: startPoi.heading || 0 });
    banner.style.display = 'none';
  };
  btn.addEventListener('click', onStart);

  return {
    dispose() {
      btn.removeEventListener('click', onStart);
      banner.remove();
    },
  };
}
