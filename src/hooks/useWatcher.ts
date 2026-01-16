import { useState, useEffect } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch } from 'chokidar';
import { ensureTargetDir } from '../config.js';

export function useWatcher(targetFile: string): string | null {
  const [targetPath, setTargetPath] = useState<string | null>(null);

  useEffect(() => {
    // Ensure the directory exists
    ensureTargetDir(targetFile);

    // Create the file if it doesn't exist
    if (!fs.existsSync(targetFile)) {
      fs.writeFileSync(targetFile, '');
    }

    // Read initial value
    const readTarget = () => {
      try {
        const content = fs.readFileSync(targetFile, 'utf-8').trim();
        if (content && content !== targetPath) {
          // Resolve to absolute path
          const resolved = path.isAbsolute(content) ? content : path.resolve(content);
          setTargetPath(resolved);
        }
      } catch {
        // Ignore read errors
      }
    };

    readTarget();

    // Watch for changes
    const watcher = watch(targetFile, {
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', readTarget);
    watcher.on('add', readTarget);

    return () => {
      watcher.close();
    };
  }, [targetFile]);

  return targetPath;
}
