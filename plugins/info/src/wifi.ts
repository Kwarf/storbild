import { encode } from "uqr";

export interface WifiNetwork {
  ssid: string;
  password?: string | undefined;
  security: "WPA" | "WEP" | "none";
  hidden?: boolean | undefined;
}

const escaped = (text: string) => text.replace(/[\\;,:"]/g, "\\$&");

/** The `WIFI:` payload that phone cameras offer to join (ADR 0015). */
export function wifiPayload(network: WifiNetwork): string {
  const open = network.security === "none";
  let payload = `WIFI:T:${open ? "nopass" : network.security};S:${escaped(network.ssid)};`;
  if (!open && network.password) payload += `P:${escaped(network.password)};`;
  if (network.hidden) payload += "H:true;";
  return `${payload};`;
}

/** A QR code as one SVG path in a `size` × `size` viewBox, quiet zone included. */
export interface QrPath {
  size: number;
  d: string;
}

/** Encodes `text` as a QR code, drawing each row's runs of dark modules as rectangles. */
export function qrPath(text: string): QrPath {
  const { size, data } = encode(text, { ecc: "M", border: 4 });
  let d = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { size, d };
}
