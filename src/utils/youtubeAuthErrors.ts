export interface FormattedGoogleAuthError {
  code: string;
  message: string;
  unauthorizedDomain?: string;
}

export function formatGoogleAuthErrorDetails(
  err: unknown,
  currentHostname?: string
): FormattedGoogleAuthError {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');
  const detectedHost =
    currentHostname ??
    (typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : '');

  if (code === 'auth/popup-blocked' || /popup-blocked/i.test(rawMessage)) {
    return {
      code: 'auth/popup-blocked',
      message:
        'Popup login Google diblokir oleh browser. Izinkan pop-up untuk situs ini lalu klik tombol Sign in with Google lagi.',
    };
  }
  if (
    code === 'auth/popup-closed-by-user' ||
    /popup-closed-by-user/i.test(rawMessage)
  ) {
    return {
      code: 'auth/popup-closed-by-user',
      message:
        'Jendela verifikasi Google ditutup sebelum selesai. Klik tombol Sign in with Google untuk melanjutkan.',
    };
  }
  if (
    code === 'auth/cancelled-popup-request' ||
    /cancelled-popup-request/i.test(rawMessage)
  ) {
    return {
      code: 'auth/cancelled-popup-request',
      message:
        'Permintaan jendela login sebelumnya dibatalkan. Silakan selesaikan proses pada jendela Google yang aktif.',
    };
  }
  if (
    code === 'auth/unauthorized-domain' ||
    /unauthorized-domain/i.test(rawMessage)
  ) {
    return {
      code: 'auth/unauthorized-domain',
      unauthorizedDomain: detectedHost || undefined,
      message: detectedHost
        ? `Domain "${detectedHost}" belum terdaftar di Authorized Domains Firebase Authentication.`
        : 'Domain aplikasi belum terdaftar di Authorized Domains Firebase Authentication.',
    };
  }
  if (
    code === 'auth/network-request-failed' ||
    /network-request-failed/i.test(rawMessage)
  ) {
    return {
      code: 'auth/network-request-failed',
      message:
        'Gagal menghubungi server verifikasi Google. Periksa koneksi internet Anda lalu coba lagi.',
    };
  }
  if (code === 'auth/user-disabled' || /user-disabled/i.test(rawMessage)) {
    return {
      code: 'auth/user-disabled',
      message: 'Akun Google ini dinonaktifkan pada project otentikasi ini.',
    };
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return {
      code: 'auth/account-exists-with-different-credential',
      message:
        'Email ini terdaftar dengan metode masuk berbeda. Gunakan akun Google utama Anda.',
    };
  }

  return {
    code: code || 'auth/unknown',
    message: rawMessage || 'Gagal memverifikasi akun Google. Silakan coba lagi.',
  };
}

export function formatGoogleAuthError(
  err: unknown,
  currentHostname?: string
): string {
  return formatGoogleAuthErrorDetails(err, currentHostname).message;
}
