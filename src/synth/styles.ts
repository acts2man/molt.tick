/**
 * Molt Stage 4 — Style resolver.
 *
 * The reference migration's hardest-won rule: NEVER round a captured value to a
 * Tailwind default. If Elementor says 25.781% or letter-spacing 3px, emit the
 * exact value as an arbitrary Tailwind class. Common values map to real Tailwind
 * tokens for readable output; everything else falls back to arbitrary values.
 *
 * Input is a ComputedEntry.style (post-JS getComputedStyle) — so this also
 * carries runtime styles a static stylesheet never had.
 */

import type { ComputedEntry } from '../ir/types.js';

const px = (v: string) => v.trim();
const num = (v: string) => parseFloat(v);

// exact px → tailwind spacing token (rem-based). only when it matches cleanly.
const SPACE: Record<string, string> = {
  '0px': '0', '4px': '1', '8px': '2', '12px': '3', '16px': '4', '20px': '5',
  '24px': '6', '32px': '8', '40px': '10', '48px': '12', '64px': '16',
};
function space(prefix: string, v: string): string {
  const t = SPACE[px(v)];
  return t ? `${prefix}-${t}` : `${prefix}-[${px(v)}]`;
}

function color(prefix: string, v: string): string | null {
  const c = v.trim();
  if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return null;
  // convert rgb(a) → hex for compact arbitrary class
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0'));
    const a = m[4] !== undefined && Number(m[4]) < 1
      ? Math.round(Number(m[4]) * 255).toString(16).padStart(2, '0') : '';
    return `${prefix}-[#${r}${g}${b}${a}]`;
  }
  return `${prefix}-[${c.replace(/\s+/g, '')}]`;
}

const FONT_WEIGHT: Record<string, string> = {
  '100': 'font-thin', '300': 'font-light', '400': 'font-normal',
  '500': 'font-medium', '600': 'font-semibold', '700': 'font-bold', '800': 'font-extrabold',
};
const TEXT_ALIGN: Record<string, string> = {
  left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify',
};

/** CSS-inherited properties: only meaningful to emit when they DIFFER from the parent. */
const INHERITED = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space',
]);

/**
 * Resolve classes but drop inherited properties whose value equals the parent's —
 * mirrors the real CSS cascade. Without this, getComputedStyle reports the
 * inherited color/font on every child, so e.g. a hero's white text bleeds onto
 * children in later light-background sections (white-on-white). This is the
 * single biggest fidelity fix.
 */
export function resolveClassesVsParent(
  style: Record<string, string>,
  parentStyle: Record<string, string> | undefined,
): string[] {
  if (!parentStyle) return resolveClasses(style);
  const effective: Record<string, string> = {};
  for (const [k, v] of Object.entries(style)) {
    if (INHERITED.has(k) && parentStyle[k] === v) continue; // same as parent → don't re-emit
    effective[k] = v;
  }
  return resolveClasses(effective);
}

/** Resolve a computed style object into an ordered, de-duped Tailwind class list. */
export function resolveClasses(style: Record<string, string>): string[] {
  const cls: string[] = [];
  const has = (k: string) => style[k] !== undefined && style[k] !== '';
  const S = (k: string) => style[k];

  // typography
  if (has('font-size')) cls.push(`text-[${px(S('font-size'))}]`);
  if (has('line-height') && S('line-height') !== 'normal') cls.push(`leading-[${px(S('line-height'))}]`);
  if (has('font-weight')) cls.push(FONT_WEIGHT[S('font-weight')] ?? `font-[${S('font-weight')}]`);
  if (has('font-style') && S('font-style') === 'italic') cls.push('italic');
  if (has('letter-spacing') && S('letter-spacing') !== 'normal') cls.push(`tracking-[${px(S('letter-spacing'))}]`);
  if (has('text-align') && TEXT_ALIGN[S('text-align')]) cls.push(TEXT_ALIGN[S('text-align')]);
  if (has('text-transform') && S('text-transform') !== 'none') cls.push(`${S('text-transform')}`.replace('uppercase', 'uppercase').replace('lowercase', 'lowercase').replace('capitalize', 'capitalize'));
  const col = has('color') ? color('text', S('color')) : null;
  if (col) cls.push(col);
  if (has('font-family')) {
    const fam = S('font-family').split(',')[0].replace(/["']/g, '').trim().replace(/\s+/g, '_');
    cls.push(`font-['${fam}']`);
  }

  // box model — only emit non-zero, exact
  for (const [side, pfx] of [['top', 'pt'], ['right', 'pr'], ['bottom', 'pb'], ['left', 'pl']] as const) {
    const v = S(`padding-${side}`);
    if (v && num(v) > 0) cls.push(space(pfx, v));
  }
  for (const [side, pfx] of [['top', 'mt'], ['right', 'mr'], ['bottom', 'mb'], ['left', 'ml']] as const) {
    const v = S(`margin-${side}`);
    if (v && num(v) > 0) cls.push(space(pfx, v));
  }

  // sizing — width as % is sacred (the 25.781% host-image lesson)
  if (has('width') && S('width') !== 'auto' && !/^0px$/.test(S('width'))) {
    const w = S('width');
    cls.push(/%$/.test(w) ? `w-[${w}]` : `w-[${px(w)}]`);
  }
  if (has('max-width') && S('max-width') !== 'none') cls.push(`max-w-[${px(S('max-width'))}]`);
  if (has('min-height') && num(S('min-height')) > 0) cls.push(`min-h-[${px(S('min-height'))}]`);

  // visual
  const bg = has('background-color') ? color('bg', S('background-color')) : null;
  if (bg) cls.push(bg);
  if (has('border-radius') && num(S('border-radius')) > 0) cls.push(`rounded-[${px(S('border-radius'))}]`);
  if (has('border-top-width') && num(S('border-top-width')) > 0) {
    cls.push(`border-t-[${px(S('border-top-width'))}]`);
    const bc = color('border', S('border-top-color') ?? '');
    if (bc) cls.push(bc);
  }
  if (has('opacity') && S('opacity') !== '1') cls.push(`opacity-[${S('opacity')}]`);
  if (has('box-shadow') && S('box-shadow') !== 'none') cls.push(`shadow-[${S('box-shadow').replace(/\s+/g, '_').replace(/,/g, ',')}]`);

  // layout
  if (has('display')) {
    const d = S('display');
    if (d === 'flex') cls.push('flex');
    else if (d === 'grid') cls.push('grid');
    else if (d === 'none') cls.push('hidden');
    else if (d === 'inline-block') cls.push('inline-block');
  }
  if (has('flex-direction') && S('flex-direction') === 'column') cls.push('flex-col');
  if (has('justify-content')) {
    const map: Record<string, string> = { 'center': 'justify-center', 'flex-start': 'justify-start', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around' };
    if (map[S('justify-content')]) cls.push(map[S('justify-content')]);
  }
  if (has('align-items')) {
    const map: Record<string, string> = { 'center': 'items-center', 'flex-start': 'items-start', 'flex-end': 'items-end', 'stretch': 'items-stretch' };
    if (map[S('align-items')]) cls.push(map[S('align-items')]);
  }
  if (has('gap') && num(S('gap')) > 0) cls.push(space('gap', S('gap')));

  return [...new Set(cls)];
}

/** Resolve straight from a sidecar entry (returns className string). */
export function classesFor(entry: ComputedEntry | undefined): string {
  if (!entry) return '';
  return resolveClasses(entry.style).join(' ');
}

/** Does this element carry a runtime transform a static stylesheet wouldn't have? */
export function hasRuntimeTransform(entry: ComputedEntry | undefined): boolean {
  if (!entry) return false;
  const t = entry.style['transform'] ?? 'none';
  const p = entry.style['perspective'] ?? 'none';
  return t.startsWith('matrix3d(') || t.startsWith('matrix(') || p !== 'none';
}
