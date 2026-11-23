# Telluride Trails

A real-time 3D trail running game set in Telluride, Colorado and the surrounding San Juan Mountains (Hardrock 100 loop: Silverton -> Telluride -> Ouray -> Lake City -> Silverton).

Live site: https://nickcoury.github.io/telluride-trails/

## Development

```bash
source ~/.nvm/nvm.sh
npm install
npm run dev
```

Dev server runs at `http://localhost:5173/telluride-trails/`.

## Build

```bash
npm run build
```

## Architecture

See [PLAN.md](./PLAN.md) for the module ownership, coordinate projection (`src/core/geo.js`), runtime interfaces, and quality tier targets.

## Data & Credits

- Elevation: USGS 3DEP via AWS Terrain Tiles (Terrarium)
- Imagery: USGS National Map Orthoimagery (public domain)
- Land Cover: MRLC NLCD (public domain)
- Trails, POIs, waterways, buildings: OpenStreetMap contributors (ODbL)
- 3D Engine: three.js (MIT)
