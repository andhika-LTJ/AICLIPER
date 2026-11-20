export function formatGoogleAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');

  if (code === 'auth/popup-blocked' || /popup-blocked/i.test(rawMessage)) {
    return 'Popup login Google diblokir oleh browser. Izinkan pop-up untuk situs ini lalu klik tombol Sign in with Google lagi.';
  }
  if (
    code === 'auth/popup-closed-by-user' ||
    /popup-closed-by-user/i.test(rawMessage)
  ) {
    return 'Jendela verifikasi Google ditutup sebelum selesai. Klik tombol Sign in with Google untuk melanjutkan.';
  }
  if (
    code === 'auth/cancelled-popup-request' ||
    /cancelled-popup-request/i.test(rawMessage)
  ) {
    return 'Permintaan jendela login sebelumnya dibatalkan. Silakan selesaikan proses pada jendela Google yang aktif.';
  }
  if (
    code === 'auth/unauthorized-domain' ||
    /unauthorized-domain/i.test(rawMessage)
  ) {
    return 'Domain aplikasi belum terdaftar di Authorized Domains Firebase Authentication.';
  }
  if (
    code === 'auth/network-request-failed' ||
    /network-request-failed/i.test(rawMessage)
  ) {
    return 'Gagal menghubungi server verifikasi Google. Periksa koneksi internet Anda lalu coba lagi.';
  }
  if (code === 'auth/user-disabled' || /user-disabled/i.test(rawMessage)) {
    return 'Akun Google ini dinonaktifkan pada project otentikasi ini.';
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return 'Email ini terdaftar dengan metode masuk berbeda. Gunakan akun Google utama Anda.';
  }

  return rawMessage || 'Gagal memverifikasi akun Google. Silakan coba lagi.';
}
