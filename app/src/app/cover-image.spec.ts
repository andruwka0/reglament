import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCoverImage } from './cover-image';

function mockCanvas(
  width: number,
  height: number,
  outputs: Blob[] = [new Blob([], { type: 'image/jpeg' })],
) {
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  let next = 0;
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(outputs[next++] ?? null);
  });
  return { bitmap, decode, context, encode };
}

const sample = new File(['image'], 'cover.png', { type: 'image/png' });

describe('formatCoverImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the aspect ratio and flattens transparency onto an opaque JPEG', async () => {
    const { decode, bitmap, context, encode } = mockCanvas(4000, 2500);

    await expect(formatCoverImage(sample)).resolves.toHaveProperty('type', 'image/jpeg');

    expect(decode).toHaveBeenCalledWith(sample, { imageOrientation: 'from-image' });
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1000);
    expect(context.fillStyle).toMatch(/^#[a-f\d]{6}$/i);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 1000);
    expect(encode.mock.calls[0][1]).toBe('image/jpeg');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('does not upscale and retries encoding when the first JPEG is too large', async () => {
    const tooLarge = new Blob([new Uint8Array(1_000_001)], { type: 'image/jpeg' });
    const compressed = new Blob(['compressed'], { type: 'image/jpeg' });
    const { bitmap, context, encode } = mockCanvas(270, 480, [tooLarge, compressed]);

    await expect(formatCoverImage(sample)).resolves.toBe(compressed);

    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 270, 480);
    expect(encode.mock.calls[1][2]).toBeLessThan(encode.mock.calls[0][2]!);
  });

  it('rejects oversized and unsupported inputs before decoding', async () => {
    const { decode } = mockCanvas(270, 480);
    await expect(
      formatCoverImage(new File(['svg'], 'cover.svg', { type: 'image/svg+xml' })),
    ).rejects.toThrow('JPEG, PNG или WebP');
    const oversized = new File([new Uint8Array(15 * 1024 ** 2 + 1)], 'cover.jpg', {
      type: 'image/jpeg',
    });
    await expect(formatCoverImage(oversized)).rejects.toThrow('15 МБ');
    expect(decode).not.toHaveBeenCalled();
  });

  it('releases the decoded image when encoding fails', async () => {
    const { bitmap } = mockCanvas(270, 480, []);

    await expect(formatCoverImage(sample)).rejects.toThrow('подготовить');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
