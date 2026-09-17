import { mkdir, writeFile, readFile, readdir, rm, copyFile, lstat } from 'node:fs/promises';
import { join, dirname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { routeFile } from './policy.js';
import type { Evidence, FileChange } from './types.js';

export const editable = (path: string) => /^src\/(?:pages|components|styles)\/[A-Za-z0-9_-]+\.(?:tsx|ts|css)$/.test(path) || path === 'src/site.css';
/** Defense-in-depth output contract, NOT an OS security sandbox. */
export function validateChanges(files: FileChange[]): void {
  if (!Array.isArray(files) || !files.length || files.length > 30) throw new Error('Expected 1..30 file changes');
  const seen = new Set<string>(); let bytes = 0;
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !editable(f.path) || seen.has(f.path)) throw new Error('Disallowed or duplicate output path');
    if (typeof f.content !== 'string' || !f.content.trim() || Buffer.byteLength(f.content) > 250000) throw new Error('Empty or oversized code file');
    seen.add(f.path); bytes += Buffer.byteLength(f.content);
    if (f.path.endsWith('.css')) {
      const css = f.content.replace(/\/\*[\s\S]*?\*\//g, '');
      if (/@import\b|url\s*\(\s*['"]?(?:https?:|data:|\/\/)/i.test(css)) throw new Error('External CSS resources require an approved integration');
      continue;
    }
    const source = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const module = node.moduleSpecifier.text;
          if (!module.startsWith('.') && !['react', 'react-dom'].includes(module)) throw new Error(`Dependency not in the trusted toolchain: ${module}`);
          if (module.startsWith('.')) {
            const target = posix.normalize(posix.join(posix.dirname(f.path), module));
            if (!target.startsWith('src/') || /[\\?\0]/.test(module)) throw new Error('Relative import escapes the source contract');
          }
        }
      }
      if (ts.isImportEqualsDeclaration(node) || ts.isMetaProperty(node)) throw new Error('Unsupported module access');
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'dangerouslySetInnerHTML') throw new Error('Raw HTML injection is not a React reconstruction');
      if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/['"]/g, '') === 'dangerouslySetInnerHTML') throw new Error('Raw HTML injection is not a React reconstruction');
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (['script','iframe','object','embed'].includes(node.tagName.getText(source).toLowerCase())) throw new Error('Unapproved embedded runtime');
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expr = node.expression.getText(source);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || /^(eval|Function|require|fetch|XMLHttpRequest|WebSocket)$/.test(expr)
          || /(?:^|\.)(insertAdjacentHTML|sendBeacon)$/.test(expr) || /(?:^|\.)location\.(assign|replace)$/.test(expr)) throw new Error('Dynamic code, network calls or redirects are not allowed');
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'process') throw new Error('Server process access is not allowed');
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        if (/(\.innerHTML|(?:^|\.)location(?:\.href)?)$/.test(node.left.getText(source))) throw new Error('Raw HTML or redirect assignment is not allowed');
      }
      if (ts.isJsxAttribute(node) && ['src','href'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)
        && /^(data:|javascript:)/i.test(node.initializer.text)) throw new Error('Inline binary content or script URL is not allowed');
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (bytes > 1_000_000) throw new Error('Change-set budget exceeded');
}
export async function snapshot(root: string): Promise<FileChange[]> {
  const result: FileChange[] = [];
  for (const folder of ['pages', 'components', 'styles']) {
    for (const name of await readdir(join(root, 'src', folder)).catch(() => [])) {
      const path = `src/${folder}/${name}`;
      if (!editable(path) || !(await lstat(join(root, path))).isFile()) throw new Error('Unexpected workspace file');
      result.push({ path, content: await readFile(join(root, path), 'utf8') });
    }
  }
  try { result.push({ path: 'src/site.css', content: await readFile(join(root, 'src/site.css'), 'utf8') }); } catch {}
  return result.sort((a,b) => a.path.localeCompare(b.path));
}
export const digest = (files: FileChange[]) => createHash('sha256').update(JSON.stringify([...files].sort((a,b) => a.path.localeCompare(b.path)))).digest('hex');
export async function apply(root: string, changes: FileChange[], allowedPages: Set<string>): Promise<void> {
  validateChanges(changes);
  for (const f of changes) if (f.path.startsWith('src/pages/') && !allowedPages.has(f.path)) throw new Error('Model attempted to invent a route');
  const current = await snapshot(root), merged = new Map(current.map(f => [f.path,f]));
  for (const f of changes) merged.set(f.path, f);
  if (merged.size > 80 || [...merged.values()].reduce((n,f)=>n+Buffer.byteLength(f.content),0)>2_000_000) throw new Error('Workspace budget exceeded');
  for (const f of changes) { await mkdir(dirname(join(root, f.path)), { recursive: true }); await writeFile(join(root, f.path), f.content); }
}
export async function restore(root: string, files: FileChange[]): Promise<void> {
  for (const folder of ['pages', 'components', 'styles']) await rm(join(root, 'src', folder), { recursive: true, force: true });
  await rm(join(root, 'src/site.css'), { force: true });
  for (const f of files) { await mkdir(dirname(join(root, f.path)), { recursive: true }); await writeFile(join(root, f.path), f.content); }
}
export async function scaffold(root: string, evidence: Evidence): Promise<void> {
  const write = async (p: string, s: string) => { await mkdir(dirname(join(root,p)), {recursive:true}); await writeFile(join(root,p), s); };
  const pkg = { name: 'molt-reconstruction', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { react:'18.3.1','react-dom':'18.3.1' }, devDependencies: { vite:'5.4.10','@vitejs/plugin-react':'4.3.3',tailwindcss:'3.4.14',postcss:'8.4.47',autoprefixer:'10.4.20' } };
  await write('package.json', JSON.stringify(pkg,null,2));
  await write('vite.config.ts', "import {defineConfig} from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({plugins:[react()]});");
  await write('tailwind.config.js', "export default {content:['./src/**/*.{ts,tsx}'],theme:{extend:{}},plugins:[]};");
  await write('postcss.config.js', "export default {plugins:{tailwindcss:{},autoprefixer:{}}};");
  await write('index.html', '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
  await write('src/index.css', '@tailwind base;\n@tailwind components;\n@tailwind utilities;');
  await write('src/fonts.css', evidence.fontFaces.join('\n'));
  await write('src/site.css', '/* Shared styles authored from the reference. */');
  const imports = evidence.pages.map((p,i)=>`import P${i} from './pages/${routeFile(p.route).split('/').pop()!.replace('.tsx','')}';`).join('\n');
  const routes = evidence.pages.map((p,i)=>`${JSON.stringify(p.route)}:P${i}`).join(',');
  const titles = Object.fromEntries(evidence.pages.map(p=>[p.route,p.title]));
  await write('src/main.tsx', `import React from 'react';import {createRoot} from 'react-dom/client';import './index.css';import './fonts.css';import './site.css';\n${imports}\nconst routes:Record<string,React.ComponentType>={${routes}};const titles:Record<string,string>=${JSON.stringify(titles)};const path=location.pathname.replace(/\\/+$/,'')||'/';const Page=routes[path];document.title=titles[path]||'Page not found';createRoot(document.getElementById('root')!).render(Page?<Page/>:<main><h1>Page not found</h1></main>);`);
  for (const a of evidence.assets) {
    if (!/^\/assets\/[a-f\d]{24}\.[a-z0-9]+$/.test(a.publicPath)) throw new Error('Unexpected asset path');
    await mkdir(join(root,'public/assets'),{recursive:true}); await copyFile(a.file,join(root,'public',a.publicPath));
  }
  await write('public/_redirects', evidence.pages.map(p=>`${p.route} /index.html 200`).join('\n'));
  await write('MOLT_OUTPUT.json', JSON.stringify({ mode:'reconstruction-agent', routes:evidence.pages.map(p=>p.route), pageFiles:evidence.pages.map(p=>({route:p.route,file:routeFile(p.route)})), warnings:evidence.warnings, blockers:evidence.blockers },null,2));
  await write('README.md', '# React reconstruction\n\nRun `npm install` then `npm run dev`. Build with `npm run build`.\n\nThis is a front-end reconstruction, not a WordPress database, authentication, payments, or form-backend migration. Review MOLT_OUTPUT.json and the separate reconstruction report for measured scope, warnings and unresolved integrations.\n');
}
