import { useLayoutEffect, useState, type ReactNode } from "react";
import { Lightbox } from "@/components/lightbox";
import { drawnQrCode, qrCodePath } from "@/lib/qr-code";

interface QrCodeLinkProps {
  url: string;
  /**
   * Whether the page draws the QR code itself, for a link whose address mustn't reach the Worker, as a
   * sign-in link's mustn't: then it's a button, where it's otherwise a link to the Worker's drawing.
   */
  drawn?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A link to `url`'s QR code that opens it in the image viewer.
 */
export function QrCodeLink({ url, drawn = false, className, children }: QrCodeLinkProps) {
  const [shown, setShown] = useState<string | null>(null);
  if (drawn) {
    return (
      <DrawnQrCode url={url} className={className}>
        {children}
      </DrawnQrCode>
    );
  }

  const path = qrCodePath(url);
  return (
    <>
      <a
        href={path}
        onClick={(event) => {
          event.preventDefault();
          setShown(path);
        }}
        className={className}
      >
        {children}
      </a>
      <Lightbox src={shown} filename="QR code.svg" onClose={() => setShown(null)} />
    </>
  );
}

/** A button that draws `url`'s QR code in the page and opens it in the image viewer. */
function DrawnQrCode({ url, className, children }: Omit<QrCodeLinkProps, "drawn">) {
  const [drawing, setDrawing] = useState<Blob | null>(null);
  const shown = useAddressOf(drawing);
  return (
    <>
      {/* Where the drawing's code can't load, there's nothing to show. */}
      <button type="button" onClick={() => void drawnQrCode(url).then(setDrawing, () => undefined)} className={className}>
        {children}
      </button>
      <Lightbox src={shown} filename="QR code.svg" onClose={() => setDrawing(null)} />
    </>
  );
}

/**
 * The address of a drawing in memory, which lasts only while it's shown: a drawing finished after the
 * button has gone is never given one.
 */
function useAddressOf(drawing: Blob | null): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!drawing) return setAddress(null);
    const address = URL.createObjectURL(drawing);
    setAddress(address);
    return () => URL.revokeObjectURL(address);
  }, [drawing]);
  return address;
}
