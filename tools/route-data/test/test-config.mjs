// Overrides for the tests: the sample OSM file's little area, six places, small matrix blocks.
export default {
  displayBox: [-139.95, -40.81, -139.85, -40.74],
  routingMarginDegrees: { lon: 0.01, lat: 0.01 },
  placeCount: 6,
  quotas: { park: 1, garden: 1, library: 1, station: 1, viewpoint: 1, square: 1 },
  ors: { matrixFallbackTile: 3 },
};
