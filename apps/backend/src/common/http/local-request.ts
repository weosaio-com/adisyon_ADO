const LOCAL_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** Istek ana bilgisayarin kendisinden mi (ilk kurulum gibi yalniz-yerel uclar icin). */
export function isLocalRequest(ip: string | undefined): boolean {
  return LOCAL_IPS.includes(ip ?? '');
}
