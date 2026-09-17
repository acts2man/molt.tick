/** Planning units, NOT money, API tokens, a live balance, or a measured site scan. */
export const CREDIT_VERSION = 'planning-2026-09-17';
export const COMPLEXITY = {
  simple: { label: 'Simple', credits: 10, description: 'Mostly text, images, buttons, and a straightforward layout.' },
  standard: { label: 'Detailed', credits: 20, description: 'Longer layouts, galleries, repeated sections, or several responsive variations.' },
  complex: { label: 'Interactive', credits: 40, description: 'Dense layouts, menus, sliders, tabs, or layered visual treatments.' },
} as const;
export type Complexity = keyof typeof COMPLEXITY;
export const PLANS = [
  { id: 'creator', name: 'Creator', credits: 150, for: 'For your next creative chapter.', feature: 'Individual sites and smaller projects.' },
  { id: 'studio', name: 'Studio', credits: 500, for: 'For a steady flow of client work.', feature: 'More room for detailed reconstructions.' },
  { id: 'agency', name: 'Agency', credits: 1500, for: 'For a growing portfolio.', feature: 'A larger shared monthly allocation.' },
] as const;
export function estimateCredits(pages: number, complexity: Complexity, repairs = 2) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 100 || !Object.hasOwn(COMPLEXITY, complexity) || !Number.isInteger(repairs) || repairs < 0 || repairs > 6) throw new Error('Invalid estimate inputs');
  const setup = 10, pageCredits = pages * COMPLEXITY[complexity].credits;
  const extraRefinement = Math.ceil(pageCredits * Math.max(0, repairs - 2) * .15);
  return { version: CREDIT_VERSION, setup, pageCredits, extraRefinement, total: setup + pageCredits + extraRefinement, pages, complexity, repairs, binding: false as const };
}
export function siteExamples(credits: number, quote: number) {
  if (!Number.isSafeInteger(credits) || credits < 0 || !Number.isSafeInteger(quote) || quote <= 0) throw new Error('Invalid credit calculation');
  return Math.floor(credits / quote);
}
