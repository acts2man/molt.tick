/**
 * Molt Stage 6 — Ship (standalone repo).
 *
 * Creates a fresh GitHub repo and pushes the COMPLETE faithful app into it —
 * package.json, vite config, index.html, router, pages, HTML, CSS, everything.
 * The result is a self-contained Vite + React project that builds and runs
 * anywhere: Replit, Vercel, Netlify, local dev, or Lovable's GitHub import.
 *
 * Molt owns the whole repo, so nothing can reject its structure. Needs a
 * fine-grained PAT (env GITHUB_TOKEN) with Contents + Administration perms.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const GH = 'https://api.github.com';

export interface ShipOptions {
  outDir: string;            // the complete faithful project dir
  repoName: string;          // desired repo name (e.g. "treasurelydesigned-react")
  token?: string;            // env GITHUB_TOKEN
  privateRepo?: boolean;     // default true
  commitMessage?: string;
}

export interface ShipResult {
  pushed: boolean;
  repoUrl?: string;          // the new repo's web URL (to hand to Replit)
  cloneUrl?: string;
  filesPushed: number;
  commit?: string;
  error?: string;
}

async function gh(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // GitHub 422s include an `errors` array with the real reason — surface it.
    const detail = body.errors ? ` — ${JSON.stringify(body.errors)}` : '';
    throw new Error(`GitHub ${res.status} on ${path}: ${body.message ?? JSON.stringify(body)}${detail}`);
  }
  return body;
}

/** Recursively collect ALL files under the project (skip build/vcs junk). */
async function collectFiles(root: string, sub = ''): Promise<{ path: string; content: Buffer }[]> {
  const out: { path: string; content: Buffer }[] = [];
  const dir = join(root, sub);
  for (const name of await readdir(dir)) {
    if (['node_modules', '.git', 'dist', 'renders'].includes(name)) continue;
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) out.push(...await collectFiles(root, join(sub, name)));
    else out.push({ path: relative(root, full).replace(/\\/g, '/'), content: await readFile(full) });
  }
  return out;
}

function sanitizeRepoName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'molt-site';
}

export async function shipToNewRepo(opts: ShipOptions): Promise<ShipResult> {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (!token) return { pushed: false, filesPushed: 0, error: 'GITHUB_TOKEN not set' };

  try {
    const me = await gh(token, '/user');
    const owner = me.login;
    const baseName = sanitizeRepoName(opts.repoName);

    // create the repo — always append a short unique suffix so we never collide
    // with a repo from a previous run (the #1 cause of 422 on creation).
    let repo: any = null;
    for (let attempt = 0; attempt < 3 && !repo; attempt++) {
      const suffix = Math.random().toString(36).slice(2, 7);
      const tryName = `${baseName}-${suffix}`.slice(0, 95);
      try {
        repo = await gh(token, '/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name: tryName,
            private: opts.privateRepo ?? true,
            auto_init: true,
            description: 'Faithful migration by Molt — connect to Replit/Vercel/local to run.',
          }),
        });
      } catch (e) {
        if (attempt === 2) throw e; // out of retries — surface the real error
      }
    }
    if (!repo) return { pushed: false, filesPushed: 0, error: 'could not create repo after retries' };
    const repoName = repo.name;

    const branch = repo.default_branch || 'main';
    await new Promise((r) => setTimeout(r, 1200)); // let auto_init settle
    const ref = await gh(token, `/repos/${owner}/${repoName}/git/ref/heads/${branch}`);
    const baseCommitSha = ref.object.sha;
    const baseCommit = await gh(token, `/repos/${owner}/${repoName}/git/commits/${baseCommitSha}`);
    const baseTreeSha = baseCommit.tree.sha;

    const files = await collectFiles(opts.outDir);
    const treeItems: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
    for (const f of files) {
      const blob = await gh(token, `/repos/${owner}/${repoName}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: f.content.toString('base64'), encoding: 'base64' }),
      });
      treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await gh(token, `/repos/${owner}/${repoName}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    const commit = await gh(token, `/repos/${owner}/${repoName}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: opts.commitMessage ?? 'Molt — faithful migration (complete app)',
        tree: newTree.sha, parents: [baseCommitSha],
      }),
    });
    await gh(token, `/repos/${owner}/${repoName}/git/refs/heads/${branch}`, {
      method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }),
    });

    return {
      pushed: true, filesPushed: treeItems.length, commit: commit.sha,
      repoUrl: repo.html_url, cloneUrl: repo.clone_url,
    };
  } catch (e) {
    return { pushed: false, filesPushed: 0, error: (e as Error).message };
  }
}
