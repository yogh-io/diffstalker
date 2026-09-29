/**
 * Reading repo files by fd, shared by the byte routes (blob) and the file
 * viewer (explorerData). Both open first and read from the same fd, so the
 * inode that was checked is the inode that is read.
 */

import * as fs from 'node:fs';

/**
 * Open read-only, and non-blocking where the platform has it. O_NONBLOCK is
 * what stops open(2) on a FIFO from parking a libuv thread forever if the
 * path is swapped between the stat and the open. Windows has no such flag,
 * hence the fallback to 0.
 */
export const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read `length` bytes from `position`. One read(2) may come back short,
 * hence the loop; a read of nothing means the file ended early (it shrank
 * under us), and then what is really there is returned rather than a tail
 * padded with zeroes.
 */
export async function readAt(
  handle: fs.promises.FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}
