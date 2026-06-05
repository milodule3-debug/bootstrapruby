import * as fs from 'fs';
import * as path from 'path';
import type { HistoryMessage } from '../providers/types.js';

/**
 * On-disk session persistence.
 * Stores conversation history in JSON so users can resume work between runs.
 * Files are namespaced under ~/.rubycode/sessions/ by default; the CLI can
 * override with a project-relative path.
 */
export const sessionStore = {
  defaultDir(): string {
    return process.env.RUBY_SESSION_DIR ?? path.join(process.env.HOME ?? '/tmp', '.rubycode', 'sessions');
  },

  async save(filePath: string, history: HistoryMessage[]): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      savedAt: new Date().toISOString(),
      version: 1,
      history,
    };
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  },

  async load(filePath: string): Promise<HistoryMessage[]> {
    if (!fs.existsSync(filePath)) return [];
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as { history?: HistoryMessage[] };
      return Array.isArray(parsed.history) ? parsed.history : [];
    } catch {
      return [];
    }
  },

  listForProject(projectRoot: string): string[] {
    const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const dir = path.join(this.defaultDir(), safe);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  },
};
