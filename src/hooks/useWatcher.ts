import { useState, useEffect } from 'react';
import { FilePathWatcher, WatcherState } from '../core/FilePathWatcher.js';

export type { WatcherState };

export interface UseWatcherState extends WatcherState {
  enabled: boolean;
}

export interface UseWatcherResult {
  state: UseWatcherState;
  setEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
}

export function useWatcher(
  initialEnabled: boolean,
  targetFile: string,
  debug: boolean = false
): UseWatcherResult {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, setState] = useState<UseWatcherState>({
    path: null,
    lastUpdate: null,
    rawContent: null,
    sourceFile: initialEnabled ? targetFile : null,
    enabled: initialEnabled,
  });

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({
        ...prev,
        enabled: false,
        sourceFile: null,
      }));
      return;
    }

    const watcher = new FilePathWatcher(targetFile, debug);

    watcher.on('path-change', (newState) => {
      setState({
        ...newState,
        enabled: true,
      });
    });

    watcher.start();

    // Set initial state from watcher
    const initialWatcherState = watcher.state;
    setState({
      ...initialWatcherState,
      enabled: true,
    });

    return () => {
      watcher.stop();
    };
  }, [enabled, targetFile, debug]);

  return { state, setEnabled };
}
