import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { hasNameToken } from '../api/textNames';

const documentPath = 'word/document.xml';
const xmlName = (name: string) => name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function restoreWordNames(
  data: ArrayBuffer,
  names: () => Promise<{ restore(text: string, formatName?: (name: string) => string): string }>,
): Promise<ArrayBuffer> {
  const zip = new Uint8Array(data);
  const partial = unzipSync(zip, { filter: entry => entry.name === documentPath });
  const document = partial[documentPath];
  if (!document) return data;
  const xml = strFromU8(document);
  if (!hasNameToken(xml)) return data;
  const codec = await names();
  const files = unzipSync(zip);
  files[documentPath] = strToU8(codec.restore(xml, xmlName));
  return new Uint8Array(zipSync(files)).buffer;
}
