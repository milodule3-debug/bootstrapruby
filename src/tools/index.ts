import type { ToolDefinition } from '../providers/types.js';
import { readFile } from './read-file.js';
import { listDir } from './list-dir.js';
import { editFile } from './edit-file.js';
import { writeFile } from './write-file.js';
import { searchCode } from './search-code.js';
import { runShell } from './run-shell.js';
import { runTests } from './run-tests.js';
import { gitStatus, gitDiff } from './git.js';
import { SPAWN_TASK_DEFINITION, executeSpawnTask } from '../agent/spawner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool schemas (what the model sees)
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file with line numbers. Use start_line/end_line to read a specific range in large files.',
    parameters: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'Path to the file (relative to project root)' },
        start_line: { type: 'number', description: 'First line to read (1-indexed, inclusive)' },
        end_line:   { type: 'number', description: 'Last line to read (inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a path. Respects .gitignore. Use recursive=true to see the whole tree.',
    parameters: {
      type: 'object',
      properties: {
        path:      { type: 'string',  description: 'Directory path (default: project root)' },
        recursive: { type: 'boolean', description: 'Whether to list recursively (default: false)' },
        depth:     { type: 'number',  description: 'Max depth for recursive listing (default: 3)' },
      },
      required: [],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by finding an exact block of text and replacing it. More reliable than rewriting the whole file. If the find block is not found, an error is returned with enough context to retry.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to the file to edit' },
        find:    { type: 'string', description: 'The exact block of text to find and replace. Must be unique in the file. Include enough surrounding lines for uniqueness.' },
        replace: { type: 'string', description: 'The new text to replace the found block with' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist. For existing files, use edit_file instead unless you need to replace the entire file.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Full content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a pattern in the codebase using ripgrep (or grep as fallback). Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern:    { type: 'string', description: 'Search pattern (regex or literal string)' },
        path:       { type: 'string', description: 'Directory to search in (default: project root)' },
        file_glob:  { type: 'string', description: 'File pattern filter, e.g. "*.ts" or "*.py"' },
        literal:    { type: 'boolean', description: 'Treat pattern as literal string, not regex (default: false)' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default: 50)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in the project directory. Use for build commands, package managers, formatters, linters. Avoid destructive commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd:     { type: 'string', description: 'Working directory (default: project root)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_tests',
    description: 'Run the test suite (or a specific test file). Automatically detects the test framework (Jest, Vitest, pytest, go test, etc.).',
    parameters: {
      type: 'object',
      properties: {
        file_or_pattern: { type: 'string', description: 'Specific test file or pattern to run (runs all tests if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'git_status',
    description: 'Show the current git status: modified files, staged changes, and recent commits.',
    parameters: {
      type: 'object', properties: {}, required: [],
    },
  },
  {
    name: 'git_diff',
    description: 'Show the diff for a specific file or all changes.',
    parameters: {
      type: 'object',
      properties: {
        path:   { type: 'string',  description: 'Specific file to diff (all files if omitted)' },
        staged: { type: 'boolean', description: 'Show staged (indexed) changes (default: false)' },
      },
      required: [],
    },
  },
  SPAWN_TASK_DEFINITION,
];

// ─────────────────────────────────────────────────────────────────────────────
// Tool executor — dispatches to the right implementation
// ─────────────────────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':    return readFile({ path: input.path as string, start_line: input.start_line as number | undefined, end_line: input.end_line as number | undefined }, cwd);
      case 'list_dir':     return listDir({ path: (input.path as string) ?? '.', recursive: (input.recursive as boolean) ?? false, depth: (input.depth as number) ?? 3 }, cwd);
      case 'edit_file':    return editFile({ path: input.path as string, find: input.find as string, replace: input.replace as string }, cwd);
      case 'write_file':   return writeFile({ path: input.path as string, content: input.content as string }, cwd);
      case 'search_code':  return searchCode({ pattern: input.pattern as string, path: input.path as string | undefined, file_glob: input.file_glob as string | undefined, literal: (input.literal as boolean) ?? false, case_sensitive: (input.case_sensitive as boolean) ?? false, max_results: (input.max_results as number) ?? 50 }, cwd);
      case 'run_shell':    return runShell({ command: input.command as string, cwd: input.cwd as string | undefined, timeout: input.timeout as number | undefined }, cwd);
      case 'run_tests':    return runTests({ file_or_pattern: input.file_or_pattern as string | undefined }, cwd);
      case 'git_status':   return gitStatus(cwd);
      case 'git_diff':     return gitDiff({ path: input.path as string | undefined, staged: (input.staged as boolean) ?? false }, cwd);
      case 'spawn_task':   return executeSpawnTask(input);
      default:             return `Error: Unknown tool '${name}'`;
    }
  } catch (e) {
    return `Tool error (${name}): ${String(e)}`;
  }
}
