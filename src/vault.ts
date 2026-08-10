import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export const VAULT_DIR = process.env.VAULT_DIR ?? path.join(process.env.HOME ?? "/home/mephisto", "ideavault");
const PROJECTS_DIR = path.join(VAULT_DIR, "Projects");

export type IdeaStatus = "idea" | "in-progress" | "blocked" | "done" | "abandoned";

export interface IdeaFrontmatter {
  repo: string;
  status: IdeaStatus;
  tags: string[];
  blockers: string[];
  next_steps: string[];
  created: string;
  updated: string;
}

export interface Idea {
  frontmatter: IdeaFrontmatter;
  body: string;
}

function slugify(repo: string): string {
  return repo.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function notePath(repo: string): string {
  return path.join(PROJECTS_DIR, `${slugify(repo)}.md`);
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function readIdea(repo: string): Promise<Idea | null> {
  try {
    const raw = await fs.readFile(notePath(repo), "utf8");
    const parsed = matter(raw);
    return { frontmatter: parsed.data as IdeaFrontmatter, body: parsed.content.trim() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface UpsertPatch {
  status?: IdeaStatus;
  tags?: string[];
  blockers?: string[];
  next_steps?: string[];
  body?: string;
}

export async function upsertIdea(repo: string, patch: UpsertPatch): Promise<Idea> {
  await ensureDirs();
  const existing = await readIdea(repo);
  const frontmatter: IdeaFrontmatter = {
    repo,
    status: patch.status ?? existing?.frontmatter.status ?? "idea",
    tags: patch.tags ?? existing?.frontmatter.tags ?? [],
    blockers: patch.blockers ?? existing?.frontmatter.blockers ?? [],
    next_steps: patch.next_steps ?? existing?.frontmatter.next_steps ?? [],
    created: existing?.frontmatter.created ?? today(),
    updated: today(),
  };
  const body = patch.body ?? existing?.body ?? `## Idea\n\n## Log\n`;
  const file = matter.stringify(body, frontmatter);
  await fs.writeFile(notePath(repo), file, "utf8");
  return { frontmatter, body };
}

export async function appendLog(repo: string, entry: string): Promise<Idea> {
  const existing = await readIdea(repo);
  const line = `- ${today()}: ${entry}`;
  let body: string;
  if (existing) {
    if (existing.body.includes("## Log")) {
      body = existing.body.replace(/## Log\n?/, `## Log\n${line}\n`);
    } else {
      body = `${existing.body}\n\n## Log\n${line}\n`;
    }
  } else {
    body = `## Idea\n\n## Log\n${line}\n`;
  }
  return upsertIdea(repo, { body });
}

export interface IdeaSummary {
  repo: string;
  status: IdeaStatus;
  tags: string[];
  updated: string;
}

export async function listIdeas(filter?: { status?: IdeaStatus; tag?: string }): Promise<IdeaSummary[]> {
  await ensureDirs();
  const files = await fs.readdir(PROJECTS_DIR).catch(() => [] as string[]);
  const summaries: IdeaSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(PROJECTS_DIR, file), "utf8");
    const parsed = matter(raw).data as IdeaFrontmatter;
    if (filter?.status && parsed.status !== filter.status) continue;
    if (filter?.tag && !parsed.tags?.includes(filter.tag)) continue;
    summaries.push({ repo: parsed.repo, status: parsed.status, tags: parsed.tags ?? [], updated: parsed.updated });
  }
  return summaries.sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export interface SearchHit {
  repo: string;
  snippet: string;
}

export async function searchNotes(query: string): Promise<SearchHit[]> {
  await ensureDirs();
  const files = await fs.readdir(PROJECTS_DIR).catch(() => [] as string[]);
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(PROJECTS_DIR, file), "utf8");
    const idx = raw.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 60);
    const end = Math.min(raw.length, idx + needle.length + 60);
    const parsed = matter(raw).data as IdeaFrontmatter;
    hits.push({ repo: parsed.repo ?? file.replace(/\.md$/, ""), snippet: raw.slice(start, end).replace(/\s+/g, " ").trim() });
  }
  return hits;
}
