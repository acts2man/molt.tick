/** Reconstruction is driven by browser evidence, not page-builder widget names. */
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const;
export type Viewport = { name: string; width: number; height: number };
export interface ElementEvidence {
  key: string; parent?: string; tag: string; text: string;
  x: number; y: number; width: number; height: number;
  style: Record<string, string>; src?: string; href?: string; svg?: string;
  before?: Record<string, string>; after?: Record<string, string>;
}
export interface Geometry {
  text: string; title: string; height: number; overflow: boolean; brokenImages: number;
  elements: ElementEvidence[]; links: string[]; embeds: string[]; forms: number;
  fontFaces: string[]; mediaQueries: string[]; truncated: boolean;
}
export type InteractionKind = 'button' | 'tab' | 'details';
export interface InteractionTrigger {
  kind: InteractionKind;
  name: string;
  /** Optional aria-controls relationship retained as evidence, never trusted as a selector. */
  controls?: string;
}
export interface InteractionReference {
  id: string;
  trigger: InteractionTrigger;
  screenshot: string;
  geometry: Geometry;
}
export interface ReferenceView {
  viewport: Viewport;
  screenshot: string;
  geometry: Geometry;
  /** Bounded, safely observed open/selected states such as menus, accordions, details and tabs. */
  interactions?: InteractionReference[];
}
export interface EvidencePage { route: string; url: string; title: string; views: ReferenceView[] }
export interface Evidence {
  site: string; directory: string; pages: EvidencePage[];
  assets: Array<{ original: string; file: string; publicPath: string }>;
  fontFaces: string[]; warnings: string[]; blockers: string[];
}
export interface FileChange { path: string; content: string }
export interface ModelReply { files: FileChange[]; summary: string }
export interface ImageInput { label: string; base64: string }
export interface ModelRequest { prompt: string; images: ImageInput[] }
export interface Model {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
  usage: { calls: number; inputTokens: number; outputTokens: number; records?: import('./usage.js').UsageRecord[]; costEstimate?: ReturnType<typeof import('./usage.js').usageSummary> };
}
export interface InteractionCheck {
  id: string;
  trigger: InteractionTrigger;
  score: number | null;
  worstBand: number | null;
  pass: boolean;
  issues: string[];
  source: string;
  candidate?: string;
  diff?: string;
  worstY?: number;
}
export interface ViewCheck {
  route: string; viewport: string; score: number | null; worstBand: number | null;
  pass: boolean; issues: string[]; source: string; candidate?: string; diff?: string; worstY?: number;
  interactions?: InteractionCheck[];
}
export interface Evaluation { pass: boolean; issues: string[]; views: ViewCheck[] }
export interface Attempt {
  round: number; accepted: boolean; summary: string; evaluation: Evaluation; digest: string;
}
export interface ReconstructionResult {
  complexity?: ReturnType<typeof import('./complexity.js').assessComplexity>;
  status: 'review' | 'needs-work'; outDir: string; reportPath: string;
  evaluation: Evaluation; attempts: Attempt[]; warnings: string[]; blockers: string[];
  usage: Model['usage']; reason?: string;
  source: {site:string;assetCount:number;pages:Array<{route:string;title:string;sections:number;elements:number}>};
}
