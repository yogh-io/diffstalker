import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { transform } from 'esbuild';

async function minifyDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory() && entry.name !== 'bundle') {
      await minifyDir(fullPath);
    } else if (entry.name.endsWith('.js')) {
      const code = await readFile(fullPath, 'utf8');
      const result = await transform(code, {
        minify: true,
        loader: 'js',
      });
      await writeFile(fullPath, result.code);
    }
  }
}

const targetDir = process.argv[2]
  ? new URL(process.argv[2], import.meta.url).pathname
  : new URL('../dist', import.meta.url).pathname;

await minifyDir(targetDir);
console.log(`Minified ${targetDir}`);
