import { checkWordTemplate, wordTemplateAccept, type WordTemplateUpload } from './wordTemplate';

const wordMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function pickWordTemplate(): Promise<WordTemplateUpload | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = wordTemplateAccept;
  input.hidden = true;
  document.body.appendChild(input);
  return new Promise((resolve, reject) => {
    input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) { resolve(null); return; }
      try {
        checkWordTemplate(file.name, file.size);
        resolve({ name: file.name, data: await file.arrayBuffer() });
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    input.click();
  });
}

export async function saveWordFile(data: ArrayBuffer, name: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([data], { type: wordMime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, '_') + ' 관찰일지.docx';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
