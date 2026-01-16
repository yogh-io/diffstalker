import { useState, useEffect, useRef } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch } from 'chokidar';
import { ensureTargetDir } from '../config.js';

export function useWatcher(targetFile: string): string | null {
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadPath = useRef<string | null>(null);

  useEffect(() => {
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
          const content = fs.readFileSync(targetFile, 'utf-8').trim();
          if (content && content !== lastReadPath.current) {
            // Resolve to absolute path
            const resolved = path.isAbsolute(content) ? content : path.resolve(content);
            lastReadPath.current = resolved;
            setTargetPath(resolved);
          }
        } catch {
          // Ignore read errors
        }
      }, 100);
    };

    // Read initial value immediately (no debounce for first read)
    try {
      const content = fs.readFileSync(targetFile, 'utf-8').trim();
      if (content) {
        const resolved = path.isAbsolute(content) ? content : path.resolve(content);
        lastReadPath.current = resolved;
        setTargetPath(resolved);
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
  }, [targetFile]);

  return targetPath;
}
