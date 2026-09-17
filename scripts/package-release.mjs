import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const name = 'sparsity-tech-static.tar.gz';
const archive = path.resolve('artifacts', name);
execFileSync('tar', ['-czf', archive, '-C', 'dist', '.'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const hash = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(`${archive}.sha256`, `${hash}  ${name}\n`);
console.log(`Static release: ${archive}\nSHA-256: ${hash}`);
