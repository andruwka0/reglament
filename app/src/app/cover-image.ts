const inputTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const inputLimit = 15 * 1024 ** 2;
const outputLimit = 1_000_000;
const maxEdge = 1600;
const jpeg = 'image/jpeg';
const preparationError = 'Не удалось подготовить обложку. Попробуйте другое изображение.';

interface DecodedCover {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

export async function formatCoverImage(file: File): Promise<Blob> {
  const supported = file.type ? inputTypes.has(file.type) : /\.(jpe?g|png|webp)$/i.test(file.name);
  if (!supported) throw new Error('Выберите изображение в формате JPEG, PNG или WebP.');
  if (file.size > inputLimit) throw new Error('Размер исходного изображения должен быть до 15 МБ.');

  const cover = await decodeCover(file);
  const canvas = document.createElement('canvas');

  try {
    try {
      if (!cover.width || !cover.height) throw new Error(preparationError);
      const scale = Math.min(1, maxEdge / Math.max(cover.width, cover.height));
      canvas.width = Math.max(1, Math.round(cover.width * scale));
      canvas.height = Math.max(1, Math.round(cover.height * scale));

      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(preparationError);
      context.imageSmoothingQuality = 'high';
      context.fillStyle = '#203a32';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(cover.source, 0, 0, canvas.width, canvas.height);
    } catch {
      throw new Error(preparationError);
    } finally {
      cover.release();
    }

    for (const quality of [0.82, 0.7, 0.58, 0.46]) {
      const result = await encodeJpeg(canvas, quality);
      if (result.size <= outputLimit) return result;
    }
    throw new Error('Обложка всё ещё больше 1 МБ. Попробуйте изображение меньшего размера.');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function decodeCover(file: File): Promise<DecodedCover> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Some browsers can decode images in an HTML image even when bitmap decoding fails.
    }
  }

  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Не удалось открыть изображение. Проверьте файл.'));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    image.onload = null;
    image.onerror = null;
  }
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, jpeg, quality));
    if (blob?.type === jpeg) return blob;
  } catch {
    // Keep browser-specific failures out of the organizer form.
  }
  throw new Error(preparationError);
}
