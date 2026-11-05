// How route-data.json and matrix.json are written: one value per line, as the site's pipeline does
// (its lib/format.mjs). On one line, neighbouring numbers run together as digits and commas, and
// the content firewall flags chance runs that read as one longer number. With every array value
// and every object member on its own line and no indentation, each number stands alone.

/** The text of `value` as JSON, one value per line, no indentation, a line break at the end. */
export function formatOnePerLine(value) {
  return `${JSON.stringify(value, null, 1).replace(/\n +/g, '\n')}\n`;
}

/** Plain JSON with two-space indentation, for files a person reads (provenance.json). */
export function formatReadable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
