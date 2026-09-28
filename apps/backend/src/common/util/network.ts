import { networkInterfaces } from 'node:os';

/** Bu bilgisayarin LAN IPv4 adresleri (loopback haric): tablet adresi ve TLS SAN icin. */
export function lanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}
