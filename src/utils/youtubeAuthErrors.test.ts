import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGoogleAuthError } from './youtubeAuthErrors.ts';

test('formatGoogleAuthError maps Firebase Auth popup & domain errors to clear Indonesian messages', () => {
  assert.match(
    formatGoogleAuthError({ code: 'auth/popup-blocked', message: 'Firebase: Error' }),
    /diblokir/i
  );
  assert.match(
    formatGoogleAuthError({ code: 'auth/popup-closed-by-user', message: 'closed' }),
    /ditutup sebelum selesai/i
  );
  assert.match(
    formatGoogleAuthError({ code: 'auth/unauthorized-domain', message: 'unauth' }),
    /Authorized Domains/i
  );
  assert.equal(
    formatGoogleAuthError(new Error('Verifikasi server gagal.')),
    'Verifikasi server gagal.'
  );
});
