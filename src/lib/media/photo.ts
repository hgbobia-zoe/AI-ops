// Shared photo capture helpers for the driver tablet dialogs (delivery proof + route
// closeout). Downscale before upload (phones shoot 3–8MB; Goodshuffle caps at 8MB and a
// smaller push is faster), then POST to /api/pod which returns stable ids the completion
// action carries. Kept framework-free so any dialog can reuse it.

/** Downscale a captured photo to longest-edge ≤1600px, JPEG q0.82. Falls back to the raw
 *  data URL on any canvas/decode failure, or "" if the file can't be read at all. */
export function downscaleImage(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch {
          resolve(src);
        }
      };
      img.onerror = () => resolve(src);
      img.src = src;
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

/** Upload downscaled data-URL photos to /api/pod. Returns the ids, or null on any failure
 *  (caller must NOT proceed as if the photos were saved — never lose proof silently). */
export async function uploadPhotos(dataUrls: string[]): Promise<string[] | null> {
  try {
    const res = await fetch("/api/pod", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: dataUrls }),
    });
    const data = (await res.json().catch(() => null)) as { photoIds?: string[] } | null;
    if (!res.ok || !data?.photoIds?.length) return null;
    return data.photoIds;
  } catch {
    return null;
  }
}
