import { ApiError } from '../api/client';
import { checkWordTemplate, type WordTemplateUpload } from './wordTemplate';

const wordMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function pickWordTemplate(): Promise<WordTemplateUpload | null> {
  const { getDocumentAsync } = await import('expo-document-picker');
  const selection = await getDocumentAsync({ copyToCacheDirectory: true });
  if (selection.canceled) return null;
  const asset = selection.assets[0];
  checkWordTemplate(asset.name, asset.size);
  const { File } = await import('expo-file-system');
  const data = await new File(asset.uri).arrayBuffer();
  checkWordTemplate(asset.name, data.byteLength);
  return { name: asset.name, data };
}

export async function saveWordFile(data: ArrayBuffer, name: string): Promise<void> {
  const [{ Directory, File, Paths }, { isAvailableAsync, shareAsync }] = await Promise.all([
    import('expo-file-system'), import('expo-sharing'),
  ]);
  if (!await isAvailableAsync()) {
    throw new ApiError(0, 'SHARING_UNAVAILABLE', '이 기기에서는 Word 파일을 공유할 수 없어요.');
  }
  const filename = name.replace(/[\\/:*?"<>|]/g, '_') + ' 관찰일지.docx';
  const directory = new Directory(Paths.cache, 'patpat-word-' + Date.now());
  directory.create();
  try {
    const file = new File(directory, filename);
    file.create();
    file.write(new Uint8Array(data));
    await shareAsync(file.uri, { mimeType: wordMime, UTI: 'org.openxmlformats.wordprocessingml.document' });
  } finally {
    directory.delete();
  }
}
