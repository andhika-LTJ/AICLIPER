import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { GoogleSignInButton } from './GoogleSignInButton';

interface GoogleLoginGateProps {
  isCheckingSession: boolean;
  isSigningIn: boolean;
  authPhase: 'idle' | 'popup' | 'verifying';
  errorMessage: string | null;
  onGoogleSignIn: () => void;
}

export function GoogleLoginGate({
  isCheckingSession,
  isSigningIn,
  authPhase,
  errorMessage,
  onGoogleSignIn,
}: GoogleLoginGateProps) {
  if (isCheckingSession) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8 text-center space-y-4">
          <div className="font-display text-xl font-bold tracking-tight text-slate-900">
            KlipCast
          </div>
          <div className="flex items-center justify-center gap-2.5 text-sm font-medium text-slate-700">
            <Loader2 className="w-4 h-4 animate-spin text-red-600 shrink-0" aria-hidden="true" />
            <span>Memeriksa dan memverifikasi sesi Google...</span>
          </div>
          <p className="text-xs text-slate-500">
            Menyiapkan koneksi aman ke akun Google dan studio kliping Anda.
          </p>
        </div>
      </div>
    );
  }

  const phaseText =
    authPhase === 'popup'
      ? 'Menunggu persetujuan pada jendela verifikasi Google...'
      : authPhase === 'verifying'
        ? 'Memverifikasi tanda tangan digital Google di server...'
        : null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-between">
      <header className="w-full border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-4">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900">
            KlipCast
          </span>
          <span className="hidden sm:inline text-xs font-medium text-slate-500">
            Studio Klip Podcast & Distribusi YouTube Shorts
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="w-full max-w-5xl mx-auto px-4 sm:px-8 py-8 sm:py-16 grid grid-cols-1 lg:grid-cols-[1.15fr_0.85fr] gap-8 lg:gap-14 items-center">
          {/* Left Column on desktop (below Sign-In card on mobile): Editorial Integration Explanation */}
          <section className="order-2 lg:order-1 space-y-6">
            <div className="space-y-3">
              <h1 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-slate-900 text-balance leading-[1.15]">
                Masuk ke Studio KlipCast dengan Akun Google
              </h1>
              <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-xl">
                Ubah link podcast YouTube menjadi video Shorts 9:16 lengkap dengan ringkasan AI
                dan publikasi langsung ke channel YouTube Anda setelah verifikasi Google.
              </p>
            </div>

            <div className="divide-y divide-slate-200 border-t border-b border-slate-200">
              <div className="py-4 space-y-1">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  01. Verifikasi Identitas Resmi Google
                </h2>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Proses masuk menggunakan layar autentikasi resmi Google dan memvalidasi token ID
                  secara kriptografis melalui sertifikat publik Google di server KlipCast.
                </p>
              </div>
              <div className="py-4 space-y-1">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  02. Terhubung dengan YouTube Shorts
                </h2>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Izin unggah YouTube (<span className="font-mono text-xs">youtube.upload</span>)
                  disiapkan sejak awal sehingga klip .MP4 hasil render bisa langsung diunggah ke
                  channel Anda.
                </p>
              </div>
              <div className="py-4 space-y-1">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  03. Kontrol Penuh & Konfirmasi Tiap Upload
                </h2>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Tidak ada publikasi diam-diam. Token akses hanya disimpan di memori sesi dan
                  setiap pengunggahan ke YouTube meminta persetujuan judul serta privasi Anda.
                </p>
              </div>
            </div>
          </section>

          {/* Right Column on desktop (first above-the-fold on mobile): Official Google Sign-In Card */}
          <section
            aria-labelledby="google-login-card-title"
            className="order-1 lg:order-2 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6"
          >
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <ShieldCheck className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                <span>Autentikasi Terintegrasi Google</span>
              </div>
              <h2
                id="google-login-card-title"
                className="font-display text-xl font-bold text-slate-900"
              >
                Verifikasi & Masuk
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                Lanjutkan dengan akun Google Anda untuk membuka Studio KlipCast dan memverifikasi
                akses YouTube Shorts.
              </p>
            </div>

            {errorMessage && (
              <div
                role="alert"
                className="p-3.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs font-medium text-red-700 leading-relaxed"
              >
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{errorMessage}</span>
              </div>
            )}

            {phaseText && !errorMessage && (
              <div
                role="status"
                className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center gap-2.5 text-xs font-medium text-slate-700"
              >
                <Loader2 className="w-4 h-4 animate-spin text-red-600 shrink-0" aria-hidden="true" />
                <span>{phaseText}</span>
              </div>
            )}

            <div className="space-y-3">
              <GoogleSignInButton
                onClick={onGoogleSignIn}
                isLoading={isSigningIn}
                label={isSigningIn ? 'Memverifikasi dengan Google...' : 'Sign in with Google'}
                fullWidth
              />
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-2 text-xs text-slate-500 leading-relaxed">
              <div className="flex items-start gap-2">
                <CheckCircle2
                  className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span>
                  Akses profil dasar (nama, email, foto) untuk identitas sesi studio KlipCast.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2
                  className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span>
                  Izin kelola upload video YouTube hanya aktif setelah konfirmasi Anda di jendela
                  resmi Google.
                </span>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-500">
          <span>KlipCast — Studio Pemotong Podcast YouTube Shorts</span>
          <span>Autentikasi aman oleh Google Identity & Firebase Auth</span>
        </div>
      </footer>
    </div>
  );
}
