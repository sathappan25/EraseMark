function timestampStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-");
}

export function formatQuickRestoreFilename(date = new Date()): string {
  return `erasemark-${timestampStamp(date)}.png`;
}

export function formatRestoreFilename(date = new Date(), format: "png" | "jpeg" = "png"): string {
  const ext = format === "jpeg" ? "jpg" : "png";
  return `restored-image-${timestampStamp(date)}.${ext}`;
}
