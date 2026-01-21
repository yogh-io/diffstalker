import { useState, useEffect, useRef } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { watch } from 'chokidar';
import { ensureTargetDir } from '../config.js';

function expandPath(p: string): string {
  // Expand ~ to home directory
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === '~') {
    return os.homedir();
  }
  return p;
}

function getLastNonEmptyLine(content: string): string {
  // Support append-only files by reading only the last non-empty line
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}

export interface WatcherState {
  path: string | null;
  lastUpdate: Date | null;
  rawContent: string | null;
  sourceFile: string | null;
  enabled: boolean;
}

export interface UseWatcherResult {
  state: WatcherState;
  setEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
}

export function useWatcher(
  initialEnabled: boolean,
  targetFile: string,
  debug: boolean = false
): UseWatcherResult {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, setState] = useState<WatcherState>({
    path: null,
    lastUpdate: null,
    rawContent: null,
    sourceFile: initialEnabled ? targetFile : null,
    enabled: initialEnabled,
  });
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadPath = useRef<string | null>(null);

  // Update state when enabled changes
  useEffect(() => {
    setState((prev) => ({
      ...prev,
      enabled,
      sourceFile: enabled ? targetFile : null,
    }));
  }, [enabled, targetFile]);

  useEffect(() => {
    // If watcher is disabled, do nothing
    if (!enabled) {
      return;
    }
    // Ensure the directory exists
    ensureTargetDir(targetFile);

    // Create the file if it doesn't exist
    if (!fs.existsSync(targetFile)) {
      fs.writeFileSync(targetFile, '');
    }

    // Read and set target path with debouncing
    const readTarget = () => {
      // Clear any pending debounce
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        try {
          const raw = fs.readFileSync(targetFile, 'utf-8');
          const content = getLastNonEmptyLine(raw);
          if (content && content !== lastReadPath.current) {
            // Expand ~ and resolve to absolute path
            const expanded = expandPath(content);
            const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
            const now = new Date();

            if (debug) {
              process.stderr.write(`[diffstalker ${now.toISOString()}] Path change detected\n`);
              process.stderr.write(`  Source file: ${targetFile}\n`);
              process.stderr.write(`  Raw content: "${content}"\n`);
              process.stderr.write(`  Previous:    "${lastReadPath.current ?? '(none)'}"\n`);
              process.stderr.write(`  Resolved:    "${resolved}"\n`);
            }

            lastReadPath.current = resolved;
            setState({
              path: resolved,
              lastUpdate: now,
              rawContent: content,
              sourceFile: targetFile,
              enabled: true,
            });
          }
        } catch {
          // Ignore read errors
        }
      }, 100);
    };

    // Read initial value immediately (no debounce for first read)
    try {
      const raw = fs.readFileSync(targetFile, 'utf-8');
      const content = getLastNonEmptyLine(raw);
      if (content) {
        // Expand ~ and resolve to absolute path
        const expanded = expandPath(content);
        const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
        const now = new Date();

        if (debug) {
          process.stderr.write(`[diffstalker ${now.toISOString()}] Initial path read\n`);
          process.stderr.write(`  Source file: ${targetFile}\n`);
          process.stderr.write(`  Raw content: "${content}"\n`);
          process.stderr.write(`  Resolved:    "${resolved}"\n`);
        }

        lastReadPath.current = resolved;

        setState({
          path: resolved,
          lastUpdate: now,
          rawContent: content,
          sourceFile: targetFile,
          enabled: true,
        });
      }
    } catch {
      // Ignore read errors
    }

    // Watch for changes
    const watcher = watch(targetFile, {
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', readTarget);
    watcher.on('add', readTarget);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      watcher.close();
    };
  }, [enabled, targetFile, debug]);

  return { state, setEnabled };
}
