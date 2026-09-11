import type { ComputedEntry } from '../ir/types.js';

/**
 * Turn Molt's verbose getComputedStyle sidecar into a compact model-readable
 * visual specification. The goal is not to serialize every CSS property; it is
 * to expose the values most useful for faithful reconstruction.
 */
export function buildVisualEvidence(entries: ComputedEntry[], maxEntries = 180): string {
  const important = entries
    .filter((e) => {
      const s = e.style ?? {};
      return Boolean(
        e.elementorId ||
        /^h[1-6]$/.test(e.tag) ||
        ['section', 'header', 'footer', 'nav', 'main', 'img', 'button', 'a'].includes(e.tag) ||
        s['background-image'] || s['transform'] !== undefined || s['position'] === 'absolute' || s['position'] === 'fixed'
      );
    })
    .slice(0, maxEntries);

  const props = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'height', 'max-width', 'min-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'color', 'background-color', 'background-image', 'background-size', 'background-position',
    'border-radius', 'box-shadow', 'opacity', 'object-fit', 'transform', 'transform-origin', 'perspective',
  ];

  const lines: string[] = [];
  lines.push(`VISUAL EVIDENCE: ${important.length} high-value elements from the rendered page.`);
  lines.push('Use these measurements to resolve ambiguity in the screenshot. Values are captured after page JavaScript settled.');

  for (const e of important) {
    const label = `${e.tag}${e.elementorId ? `#${e.elementorId}` : ''} @ ${e.path}`;
    const bits: string[] = [];
    for (const p of props) {
      const v = e.style?.[p];
      if (v && v !== 'none' && v !== 'normal' && v !== 'auto') bits.push(`${p}=${v}`);
    }
    if (bits.length) lines.push(`- ${label}: ${bits.join('; ')}`);
  }

  return lines.join('\n');
}
