import { runPipeline } from './run.js';

const [siteUrl = 'http://local/', workDir = '/tmp/molt-run'] = process.argv.slice(2);
const reuse = process.argv.includes('--reuse') ? process.argv[process.argv.indexOf('--reuse') + 1] : undefined;

const result = await runPipeline({
  siteUrl, workDir, reuseCaptureDir: reuse,
  onProgress: (e) => {
    const tag = `[${e.stage}]`.padEnd(13);
    console.log(`${tag} ${e.status.padEnd(12)} ${e.message}`);
  },
});

console.log('\n=== RESULT ===');
console.log(`status: ${result.status} · elapsed ${result.elapsed_seconds}s · ${result.assets} assets`);
console.log(`route checks: ${result.routeChecks.passed}/${result.routeChecks.total}`);
console.log('\npages (as written to platform):');
for (const p of result.pages) {
  console.log(`  ${p.route.padEnd(20)} ${String(p.section_count).padStart(2)} sec · ${String(p.widget_count).padStart(3)} wid · pixel ${p.pixel_match ?? '—'} · ${p.status}`);
}
console.log('\nflags:');
for (const f of result.flags) console.log(`  [${f.kind}] ${f.page_route} — ${f.summary}`);
if (result.error) console.log(`\nERROR: ${result.error}`);
