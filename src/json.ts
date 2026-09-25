import { readFile } from 'node:fs/promises';

/** JSON.parse, naming the file in the error: a tree has hundreds of JSON files. */
export function parseJson<T = unknown>(text: string, file: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  return parseJson<T>(await readFile(file, 'utf8'), file);
}
