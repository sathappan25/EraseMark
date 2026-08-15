export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.startsWith("data:")) {
        reject(new Error("Could not encode the restored image."));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error("Could not encode the restored image."));
    reader.readAsDataURL(blob);
  });
}
