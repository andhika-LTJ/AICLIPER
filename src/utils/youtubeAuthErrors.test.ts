import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGoogleAuthError,
  formatGoogleAuthErrorDetails,
} from './youtubeAuthErrors.ts';

test('formatGoogleAuthError maps Firebase Auth popup & domain errors to clear Indonesian messages', () => {
  assert.match(
    formatGoogleAuthError({ code: 'auth/popup-blocked', message: 'Firebase: Error' }),
    /diblokir/i
  );
  assert.match(
    formatGoogleAuthError({ code: 'auth/popup-closed-by-user', message: 'closed' }),
    /ditutup sebelum selesai/i
  );
  const domainErr = formatGoogleAuthErrorDetails(
    { code: 'auth/unauthorized-domain', message: 'unauth' },
    'localhost'
  );
  assert.equal(domainErr.code, 'auth/unauthorized-domain');
  assert.equal(domainErr.unauthorizedDomain, 'localhost');
  assert.match(domainErr.message, /Domain "localhost" belum terdaftar/);

  assert.equal(
    formatGoogleAuthError(new Error('Verifikasi server gagal.')),
    'Verifikasi server gagal.'
  );
});
