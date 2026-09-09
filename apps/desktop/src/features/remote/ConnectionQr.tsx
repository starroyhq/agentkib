import { useMemo } from "react";
import { create } from "qrcode";

/** Render locally: never send the user's network address to a QR image service. */
export function ConnectionQr({ url, label }: { url: string; label: string }) {
  const qr = useMemo(() => {
    const { modules } = create(url, { errorCorrectionLevel: "M" });
    const squares: string[] = [];
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) squares.push(`M${col + 4} ${row + 4}h1v1h-1z`);
      }
    }
    return { size: modules.size + 8, path: squares.join("") };
  }, [url]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="h-44 w-44 shrink-0"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="white" />
      <path d={qr.path} fill="black" />
    </svg>
  );
}
