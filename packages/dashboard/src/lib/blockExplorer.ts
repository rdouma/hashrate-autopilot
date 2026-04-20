/**
 * Block-explorer URL templating (issue #22).
 *
 * The daemon stores a single string template (e.g.
 * `https://mempool.space/block/{hash}`); the dashboard substitutes
 * `{hash}` and `{height}` at click time. Both placeholders are
 * optional — the config schema enforces that at least one is present.
 */

export function applyExplorerTemplate(
  template: string,
  block: { block_hash?: string; height?: number },
): string {
  let url = template;
  if (block.block_hash !== undefined) {
    url = url.split('{hash}').join(encodeURIComponent(block.block_hash));
  }
  if (block.height !== undefined) {
    url = url.split('{height}').join(String(block.height));
  }
  return url;
}
