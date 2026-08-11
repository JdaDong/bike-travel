// 极简 Protomaps 矢量样式（source 为 pmtiles://...），仅渲染 earth/water/roads/buildings
export function pmtilesStyle(url: string): any {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      protomaps: { type: 'vector', url: `pmtiles://${url}` },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef3f6' } },
      { id: 'earth', type: 'fill', source: 'protomaps', 'source-layer': 'earth', paint: { 'fill-color': '#e7ede6' } },
      { id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water', paint: { 'fill-color': '#aadaff' } },
      { id: 'roads', type: 'line', source: 'protomaps', 'source-layer': 'roads', paint: { 'line-color': '#ffffff', 'line-width': 1 } },
      { id: 'buildings', type: 'fill', source: 'protomaps', 'source-layer': 'buildings', paint: { 'fill-color': '#d9d2c7', 'fill-opacity': 0.6 } },
    ],
  }
}
