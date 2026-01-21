import { useEffect, useState, useCallback, useRef } from 'react';
import { useStdin } from 'ink';

export interface MouseEvent {
  x: number;
  y: number;
  type: 'click' | 'scroll-up' | 'scroll-down';
  button: 'left' | 'middle' | 'right' | 'none';
}

export function useMouse(
  onEvent: (event: MouseEvent) => void,
  disabled: boolean = false
): { mouseEnabled: boolean; toggleMouse: () => void } {
  const { stdin, setRawMode } = useStdin();
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  const toggleMouse = useCallback(() => {
    setMouseEnabled((prev) => !prev);
  }, []);

  // Store mouseEnabled in ref for use in event handler
  const mouseEnabledRef = useRef(mouseEnabled);
  useEffect(() => {
    mouseEnabledRef.current = mouseEnabled;
  }, [mouseEnabled]);

  // Handle mouse mode changes (disable only when text input is focused)
  // Note: We keep mouse tracking enabled even in "select mode" so clicks still work
  useEffect(() => {
    if (!disabled) {
      process.stdout.write('\x1b[?1000h');
      process.stdout.write('\x1b[?1006h');
    } else {
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
    }
  }, [disabled]);

  // Set up event listener (separate from mode toggle)
  useEffect(() => {
    if (!stdin || !setRawMode) return;

    const handleData = (data: Buffer) => {
      const str = data.toString();

      // Parse SGR mouse events: \x1b[<button;x;y[Mm]
      // eslint-disable-next-line no-control-regex
      const sgrMatch = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (sgrMatch) {
        const buttonCode = parseInt(sgrMatch[1], 10);
        const x = parseInt(sgrMatch[2], 10);
        const y = parseInt(sgrMatch[3], 10);
        const isRelease = sgrMatch[4] === 'm';

        // Scroll wheel events (button codes 64-67) - only when in scroll mode
        if (buttonCode >= 64 && buttonCode < 96) {
          if (mouseEnabledRef.current) {
            const type = buttonCode === 64 ? 'scroll-up' : 'scroll-down';
            onEventRef.current({ x, y, type, button: 'none' });
          }
        }
        // Click events (button codes 0-2) - only on release to avoid double-firing
        else if (isRelease && buttonCode >= 0 && buttonCode < 3) {
          const button = buttonCode === 0 ? 'left' : buttonCode === 1 ? 'middle' : 'right';
          onEventRef.current({ x, y, type: 'click', button });
        }

        return;
      }

      // Parse legacy mouse events
      // eslint-disable-next-line no-control-regex
      const legacyMatch = str.match(/\x1b\[M(.)(.)(.)/);
      if (legacyMatch) {
        const buttonCode = legacyMatch[1].charCodeAt(0) - 32;
        const x = legacyMatch[2].charCodeAt(0) - 32;
        const y = legacyMatch[3].charCodeAt(0) - 32;

        if (buttonCode >= 64) {
          if (mouseEnabledRef.current) {
            const type = buttonCode === 64 ? 'scroll-up' : 'scroll-down';
            onEventRef.current({ x, y, type, button: 'none' });
          }
        }
        // Legacy click events (button codes 0-2)
        else if (buttonCode >= 0 && buttonCode < 3) {
          const button = buttonCode === 0 ? 'left' : buttonCode === 1 ? 'middle' : 'right';
          onEventRef.current({ x, y, type: 'click', button });
        }
      }
    };

    stdin.on('data', handleData);

    return () => {
      stdin.off('data', handleData);
      // Disable mouse tracking on unmount
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
    };
  }, [stdin, setRawMode]);

  return { mouseEnabled, toggleMouse };
}
