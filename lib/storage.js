import {randomUUID} from 'node:crypto';
import {mkdir, open, rename, unlink, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export async function readLocal(path, maxBytes) {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('本地文件超过大小限制');
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function saveLocal(path, bytes, signal) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, {mode: 0o600, flag: 'wx', signal});
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
