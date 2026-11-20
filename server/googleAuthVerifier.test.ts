import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  GoogleTokenVerificationError,
  parseCacheControlMaxAgeMs,
  verifyFirebaseGoogleIdTokenWithCerts,
} from './googleAuthVerifier.ts';

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signTestJwt(
  payload: Record<string, unknown>,
  privateKey: string,
  kid = 'test-kid-1',
  alg = 'RS256'
): string {
  const headerB64 = toBase64Url(JSON.stringify({ alg, typ: 'JWT', kid }));
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${headerB64}.${payloadB64}`);
  signer.end();
  const sig = signer.sign(privateKey);
  return `${headerB64}.${payloadB64}.${toBase64Url(sig)}`;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_PROJECT = 'gen-lang-client-0564579246';
const NOW = 1_795_000_000;

test('verifyFirebaseGoogleIdTokenWithCerts accepts valid Google-verified token', () => {
  const token = signTestJwt(
    {
      aud: TEST_PROJECT,
      iss: `https://securetoken.google.com/${TEST_PROJECT}`,
      sub: 'google-uid-123',
      iat: NOW - 60,
      exp: NOW + 3540,
      auth_time: NOW - 60,
      email: 'creator@gmail.com',
      email_verified: true,
      name: 'Kreator Podcast',
      picture: 'https://lh3.googleusercontent.com/a/photo',
      firebase: { sign_in_provider: 'google.com' },
    },
    privateKey
  );

  const verified = verifyFirebaseGoogleIdTokenWithCerts({
    idToken: token,
    certsByKid: { 'test-kid-1': publicKey },
    projectId: TEST_PROJECT,
    nowSec: NOW,
  });

  assert.equal(verified.uid, 'google-uid-123');
  assert.equal(verified.email, 'creator@gmail.com');
  assert.equal(verified.emailVerified, true);
  assert.equal(verified.name, 'Kreator Podcast');
  assert.equal(verified.signInProvider, 'google.com');
});

test('verifyFirebaseGoogleIdTokenWithCerts rejects expired, wrong-project, non-Google, and tampered tokens', () => {
  const expiredToken = signTestJwt(
    {
      aud: TEST_PROJECT,
      iss: `https://securetoken.google.com/${TEST_PROJECT}`,
      sub: 'uid-1',
      iat: NOW - 4000,
      exp: NOW - 120,
      firebase: { sign_in_provider: 'google.com' },
    },
    privateKey
  );
  assert.throws(
    () =>
      verifyFirebaseGoogleIdTokenWithCerts({
        idToken: expiredToken,
        certsByKid: { 'test-kid-1': publicKey },
        projectId: TEST_PROJECT,
        nowSec: NOW,
      }),
    (err: unknown) =>
      err instanceof GoogleTokenVerificationError && err.code === 'TOKEN_EXPIRED'
  );

  const wrongAudToken = signTestJwt(
    {
      aud: 'other-project',
      iss: `https://securetoken.google.com/${TEST_PROJECT}`,
      sub: 'uid-1',
      iat: NOW - 10,
      exp: NOW + 3600,
      firebase: { sign_in_provider: 'google.com' },
    },
    privateKey
  );
  assert.throws(
    () =>
      verifyFirebaseGoogleIdTokenWithCerts({
        idToken: wrongAudToken,
        certsByKid: { 'test-kid-1': publicKey },
        projectId: TEST_PROJECT,
        nowSec: NOW,
      }),
    (err: unknown) =>
      err instanceof GoogleTokenVerificationError && err.code === 'PROJECT_MISMATCH'
  );

  const passwordProviderToken = signTestJwt(
    {
      aud: TEST_PROJECT,
      iss: `https://securetoken.google.com/${TEST_PROJECT}`,
      sub: 'uid-1',
      iat: NOW - 10,
      exp: NOW + 3600,
      firebase: { sign_in_provider: 'password' },
    },
    privateKey
  );
  assert.throws(
    () =>
      verifyFirebaseGoogleIdTokenWithCerts({
        idToken: passwordProviderToken,
        certsByKid: { 'test-kid-1': publicKey },
        projectId: TEST_PROJECT,
        nowSec: NOW,
      }),
    (err: unknown) =>
      err instanceof GoogleTokenVerificationError &&
      err.code === 'GOOGLE_PROVIDER_REQUIRED'
  );

  const validToken = signTestJwt(
    {
      aud: TEST_PROJECT,
      iss: `https://securetoken.google.com/${TEST_PROJECT}`,
      sub: 'uid-1',
      iat: NOW - 10,
      exp: NOW + 3600,
      firebase: { sign_in_provider: 'google.com' },
    },
    privateKey
  );
  const tampered = `${validToken.slice(0, -4)}AAAA`;
  assert.throws(
    () =>
      verifyFirebaseGoogleIdTokenWithCerts({
        idToken: tampered,
        certsByKid: { 'test-kid-1': publicKey },
        projectId: TEST_PROJECT,
        nowSec: NOW,
      }),
    (err: unknown) =>
      err instanceof GoogleTokenVerificationError && err.code === 'INVALID_SIGNATURE'
  );
});

test('parseCacheControlMaxAgeMs respects Google cert max-age header', () => {
  assert.equal(parseCacheControlMaxAgeMs('public, max-age=1800'), 1_800_000);
  assert.equal(parseCacheControlMaxAgeMs(null), 3_600_000);
});
