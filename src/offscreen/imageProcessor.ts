export async function fetchAndDecodeImage(imageUrl: string): Promise<{ blob: Blob; bitmap: ImageBitmap }> {
  console.log("[EraseMark] FETCH_IMAGE", imageUrl);

  const response = await fetch(imageUrl, {
    credentials: "omit",
  });

  if (!response.ok) {
    throw new Error(`Image request failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  console.log("[EraseMark] Content-Type:", contentType);

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error("The image response was empty.");
  }

  console.log("[EraseMark] Image bytes:", blob.size);

  const bitmap = await createImageBitmap(blob);
  console.log("[EraseMark] Image decoded:", bitmap.width, "x", bitmap.height);
  console.log("[EraseMark] FETCH_IMAGE ✓");
  console.log("[EraseMark] DECODE_IMAGE ✓");

  return { blob, bitmap };
}

export async function decodeImageBlob(blob: Blob): Promise<ImageBitmap> {
  console.log("[EraseMark] DECODE_IMAGE");
  if (!blob || blob.size === 0) {
    throw new Error("The image response was empty.");
  }
  try {
    const bitmap = await createImageBitmap(blob);
    console.log("[EraseMark] Image decoded:", bitmap.width, "x", bitmap.height);
    console.log("[EraseMark] DECODE_IMAGE ✓");
    return bitmap;
  } catch (error) {
    console.error("[EraseMark ERROR] DECODE_IMAGE", error);
    throw new Error("Could not decode this image format.");
  }
}
