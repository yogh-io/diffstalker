import { useEffect } from 'react';
import { useStdin } from 'ink';

export interface MouseEvent {
  x: number;
  y: number;
  type: 'click' | 'scroll-up' | 'scroll-down';
  button: 'left' | 'middle' | 'right' | 'none';
}

export function useMouse(onEvent: (event: MouseEvent) => void): void {
  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    if (!stdin || !setRawMode) return;

    // Enable mouse tracking (SGR extended mode for better coordinates)
    // 1000h enables basic click tracking only - text selection still works
    process.stdout.write('\x1b[?1000h'); // Enable click tracking
    process.stdout.write('\x1b[?1006h'); // Enable SGR extended mode

    const handleData = (data: Buffer) => {
      const str = data.toString();

      // Parse SGR mouse events: \x1b[<button;x;y[Mm]
      const sgrMatch = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (sgrMatch) {
        const buttonCode = parseInt(sgrMatch[1], 10);
        const x = parseInt(sgrMatch[2], 10);
        const y = parseInt(sgrMatch[3], 10);
        const isRelease = sgrMatch[4] === 'm';

        // Determine button
        const baseButton = buttonCode & 3;
        let button: MouseEvent['button'] = 'none';
        if (baseButton === 0) button = 'left';
        else if (baseButton === 1) button = 'middle';
        else if (baseButton === 2) button = 'right';

        // Scroll wheel (button codes 64-67)
        if (buttonCode >= 64 && buttonCode < 96) {
          const type = buttonCode === 64 ? 'scroll-up' : 'scroll-down';
          onEvent({ x, y, type, button: 'none' });
          return;
        }

        // Click on release
        if (isRelease && buttonCode < 64) {
          onEvent({ x, y, type: 'click', button });
        }

        return;
      }

      // Parse legacy mouse events: \x1b[M<button><x><y>
      const legacyMatch = str.match(/\x1b\[M(.)(.)(.)/);
      if (legacyMatch) {
        const buttonCode = legacyMatch[1].charCodeAt(0) - 32;
        const x = legacyMatch[2].charCodeAt(0) - 32;
        const y = legacyMatch[3].charCodeAt(0) - 32;

        // Scroll wheel
        if (buttonCode >= 64) {
          const type = buttonCode === 64 ? 'scroll-up' : 'scroll-down';
          onEvent({ x, y, type, button: 'none' });
          return;
        }

        // Click (on release, buttonCode & 3 === 3)
        if ((buttonCode & 3) === 3) {
          onEvent({ x, y, type: 'click', button: 'left' });
        }
      }
    };

    stdin.on('data', handleData);

    return () => {
      stdin.off('data', handleData);
      // Disable mouse tracking
      process.stdout.write('\x1b[?1006l');
      process.stdout.write('\x1b[?1000l');
    };
  }, [stdin, setRawMode, onEvent]);
}
