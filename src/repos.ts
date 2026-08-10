import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readIdea } from "./vault.js";

const execFileAsync = promisify(execFile);

const REPOS_DIR = process.env.REPOS_DIR ?? process.env.HOME ?? "/home/mephisto";

const EXCLUDE = new Set([
  "ideavault", "ideavault-mcp", "tmp", "ztmp", "config", "data", "definitions",
  "resource_packs", "go", "MINECRAFT_BEDROCK_UPDATE_NOTES.md", "NGINX.md", "profanity_filter.wlist",
]);

const STACK_MARKERS: Record<string, string> = {
  "package.json": "node",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "*.csproj": "dotnet",
};

async function detectStack(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const stacks = new Set<string>();
  for (const entry of entries) {
    if (STACK_MARKERS[entry]) stacks.add(STACK_MARKERS[entry]);
    if (entry.endsWith(".csproj")) stacks.add("dotnet");
    if (entry === ".git") stacks.add("git");
  }
  return [...stacks];
}

export interface RepoInfo {
  name: string;
  path: string;
  stacks: string[];
  lastModified: string;
  hasNote: boolean;
}

export async function listRepos(): Promise<RepoInfo[]> {
  const entries = await fs.readdir(REPOS_DIR, { withFileTypes: true });
  const repos: RepoInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDE.has(entry.name)) continue;
    const full = path.join(REPOS_DIR, entry.name);
    const stat = await fs.stat(full);
    const [stacks, note] = await Promise.all([detectStack(full), readIdea(entry.name)]);
    repos.push({
      name: entry.name,
      path: full,
      stacks,
      lastModified: stat.mtime.toISOString().slice(0, 10),
      hasNote: note !== null,
    });
  }
  return repos.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
}

// --- Reading inside a repo (for writing informed notes) -------------------

const DIR_EXCLUDE = new Set([
  ".git", "node_modules", "target", "dist", "build", "__pycache__",
  ".venv", "venv", "vendor", ".next", ".turbo", ".cache",
]);

// Filenames/paths that commonly hold secrets or key material. Several of these
// repos are Solana trading bots where wallet keypairs are plain JSON byte
// arrays, so this list errs conservative rather than trying to be clever.
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12|jks)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|\/)(\.ssh|\.aws|\.gnupg)\//i,
  /(^|\/)([^/]*)(secret|credential|keypair|wallet)([^/]*)\.(json|ya?ml|txt)$/i,
];

function isSensitivePath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  return SENSITIVE_PATTERNS.some((re) => re.test(normalized));
}

function resolveInRepo(repo: string, relPath: string): string {
  if (repo.includes("/") || repo.includes("..") || repo.startsWith(".")) {
    throw new Error("invalid repo name");
  }
  const repoRoot = path.join(REPOS_DIR, repo);
  const target = path.resolve(repoRoot, relPath || ".");
  if (target !== repoRoot && !target.startsWith(repoRoot + path.sep)) {
    throw new Error("path escapes repo directory");
  }
  return target;
}

export interface RepoEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export async function listRepoFiles(repo: string, subpath = ""): Promise<RepoEntry[]> {
  const dir = resolveInRepo(repo, subpath);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: RepoEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip dotfiles/dot-dirs (.git, .env, .ssh, etc.)
    const rel = path.posix.join(subpath, entry.name);
    if (entry.isDirectory()) {
      if (DIR_EXCLUDE.has(entry.name)) continue;
      results.push({ name: rel, type: "dir" });
    } else if (entry.isFile()) {
      if (isSensitivePath(rel)) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      results.push({ name: rel, type: "file", size: stat.size });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_READ_BYTES = 200_000;

export interface RepoFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

export async function readRepoFile(repo: string, relPath: string): Promise<RepoFileContent> {
  if (isSensitivePath(relPath)) {
    throw new Error(`refusing to read '${relPath}': matches a secret/key-file pattern`);
  }
  const target = resolveInRepo(repo, relPath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(`not a file: ${relPath}`);
  const handle = await fs.open(target, "r");
  try {
    const readLen = Math.min(stat.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(readLen);
    await handle.read(buf, 0, readLen, 0);
    if (buf.subarray(0, readLen).includes(0)) {
      throw new Error(`refusing to read '${relPath}': appears to be a binary file`);
    }
    return { path: relPath, content: buf.toString("utf8"), truncated: stat.size > MAX_READ_BYTES };
  } finally {
    await handle.close();
  }
}

// --- Writing inside a repo (best-effort git safety net first) --------------

const GITIGNORE_DEFAULTS = [...DIR_EXCLUDE].map((d) => `${d}/`).join("\n") + "\n.env\n.env.*\n*.pem\n*.key\n";

export interface GitSafetyStatus {
  initialized: boolean; // true if we just ran `git init` + a snapshot commit
  hadPriorChanges: boolean; // true if the repo already had uncommitted changes before this write
  note?: string; // set if the safety net itself failed (write still proceeds)
}

async function ensureGitSafetyNet(repoRoot: string): Promise<GitSafetyStatus> {
  const hasGit = await fs.stat(path.join(repoRoot, ".git")).then(() => true).catch(() => false);
  if (!hasGit) {
    try {
      await execFileAsync("git", ["init"], { cwd: repoRoot });
      const gitignorePath = path.join(repoRoot, ".gitignore");
      const existing = await fs.readFile(gitignorePath, "utf8").catch(() => "");
      if (!existing) await fs.writeFile(gitignorePath, GITIGNORE_DEFAULTS, "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: repoRoot });
      await execFileAsync("git", ["commit", "-m", "ideavault-mcp: initial snapshot before first automated edit", "--allow-empty"], { cwd: repoRoot });
      return { initialized: true, hadPriorChanges: false };
    } catch (err) {
      return { initialized: false, hadPriorChanges: false, note: `git safety snapshot failed: ${(err as Error).message}` };
    }
  }
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
    return { initialized: false, hadPriorChanges: stdout.trim().length > 0 };
  } catch (err) {
    return { initialized: false, hadPriorChanges: false, note: `git status check failed: ${(err as Error).message}` };
  }
}

const MAX_WRITE_BYTES = 500_000;

export interface WriteResult {
  path: string;
  bytesWritten: number;
  created: boolean;
  git: GitSafetyStatus;
}

export async function writeRepoFile(repo: string, relPath: string, content: string): Promise<WriteResult> {
  if (isSensitivePath(relPath)) {
    throw new Error(`refusing to write '${relPath}': matches a secret/key-file pattern`);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`content too large (max ${MAX_WRITE_BYTES} bytes)`);
  }
  const target = resolveInRepo(repo, relPath);
  const repoRoot = path.join(REPOS_DIR, repo);
  const existed = await fs.stat(target).then(() => true).catch(() => false);
  const git = await ensureGitSafetyNet(repoRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return { path: relPath, bytesWritten: Buffer.byteLength(content, "utf8"), created: !existed, git };
}

export interface EditResult {
  path: string;
  git: GitSafetyStatus;
}

export async function editRepoFile(repo: string, relPath: string, oldString: string, newString: string): Promise<EditResult> {
  if (isSensitivePath(relPath)) {
    throw new Error(`refusing to edit '${relPath}': matches a secret/key-file pattern`);
  }
  const target = resolveInRepo(repo, relPath);
  const repoRoot = path.join(REPOS_DIR, repo);
  const current = await fs.readFile(target, "utf8");
  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_string not found in ${relPath}`);
  if (occurrences > 1) {
    throw new Error(`old_string matches ${occurrences} times in ${relPath} — provide more surrounding context to make it unique`);
  }
  const updated = current.replace(oldString, newString);
  const git = await ensureGitSafetyNet(repoRoot);
  await fs.writeFile(target, updated, "utf8");
  return { path: relPath, git };
}
