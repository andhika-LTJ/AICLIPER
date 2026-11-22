import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isBlockedIpAddress,
  isSafeResourceId,
  resolveConfinedPath,
  sanitizeAutomationForClient,
  validateSafeExternalUrl,
  validateVideoMagicBytes,
} from './security.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';

test('isBlockedIpAddress blocks loopback, private LAN, link-local metadata, multicast, and IPv4-mapped IPv6', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIpAddress(ip), true, `Expected IP ${ip} to be blocked`);
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '142.250.190.78', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    assert.equal(isBlockedIpAddress(ip), false, `Expected public IP ${ip} to be allowed`);
  }
});

test('validateSafeExternalUrl rejects localhost, metadata IPs, private IPs, credentials, and non-HTTP schemes', async () => {
  const unsafeUrls = [
    'http://localhost:3000/api/state',
    'http://127.0.0.1:8080/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.10/internal',
    'http://192.168.0.1/admin',
    'http://[::1]/secret',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com/hook',
  ];

  for (const url of unsafeUrls) {
    const result = await validateSafeExternalUrl(url, { requireHttps: false });
    assert.equal(result.valid, false, `Expected URL ${url} to be rejected`);
  }
});

test('validateSafeExternalUrl enforces HTTPS and domain allowlist when configured', async () => {
  const httpRejected = await validateSafeExternalUrl('http://8.8.8.8/hook', {
    requireHttps: true,
    skipDnsLookup: true,
  });
  assert.equal(httpRejected.valid, false);

  const allowlistRejected = await validateSafeExternalUrl('https://evil.example.org/hook', {
    requireHttps: true,
    allowedDomainsEnv: 'hooks.slack.com,n8n.trusted.id',
    skipDnsLookup: true,
  });
  assert.equal(allowlistRejected.valid, false);

  const allowlistPassed = await validateSafeExternalUrl('https://sub.n8n.trusted.id/webhook/123', {
    requireHttps: true,
    allowedDomainsEnv: 'hooks.slack.com,n8n.trusted.id',
    skipDnsLookup: true,
  });
  assert.equal(allowlistPassed.valid, true);
});

test('isSafeResourceId and resolveConfinedPath prevent path traversal', () => {
  assert.equal(isSafeResourceId('clip-abc_123'), true);
  assert.equal(isSafeResourceId('../etc/passwd'), false);
  assert.equal(isSafeResourceId('clip/../../secret'), false);
  assert.equal(isSafeResourceId('clip..id'), false);
  assert.equal(isSafeResourceId(''), false);

  const base = path.resolve('/tmp/klipcast-test-base');
  const safe = resolveConfinedPath(base, 'clip_001.mp4');
  assert.equal(safe, path.join(base, 'clip_001.mp4'));

  assert.throws(() => {
    resolveConfinedPath(base, '../../etc/passwd');
  });
});

test('validateVideoMagicBytes accepts valid MP4/WebM headers and rejects HTML/scripts', () => {
  // Valid ISO BMFF MP4 header: [size 4 bytes] + 'ftypisom'
  const mp4Header = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  const mp4Result = validateVideoMagicBytes(mp4Header);
  assert.equal(mp4Result.valid, true);
  assert.equal(mp4Result.detectedFormat, 'mp4_mov');

  // Valid EBML / WebM / MKV header
  const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x00, 0x00, 0x00]);
  const webmResult = validateVideoMagicBytes(webmHeader);
  assert.equal(webmResult.valid, true);
  assert.equal(webmResult.detectedFormat, 'webm_mkv');

  // Malicious HTML / script masquerading as video
  const fakeHtml = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');
  assert.equal(validateVideoMagicBytes(fakeHtml).valid, false);

  const fakePhp = Buffer.from('<?php system($_GET["c"]); ?>');
  assert.equal(validateVideoMagicBytes(fakePhp).valid, false);
});

test('sanitizeAutomationForClient redacts webhookSecretHeader while preserving hasWebhookSecret flag', () => {
  const sanitized = sanitizeAutomationForClient({
    ...INITIAL_STUDIO_STATE.automation,
    webhookUrl: 'https://hooks.example.com/klipcast',
    webhookSecretHeader: 'super-secret-token-999',
  });
  assert.equal(sanitized.webhookSecretHeader, '');
  assert.equal(sanitized.hasWebhookSecret, true);

  const sanitizedEmpty = sanitizeAutomationForClient({
    ...INITIAL_STUDIO_STATE.automation,
    webhookSecretHeader: '',
  });
  assert.equal(sanitizedEmpty.webhookSecretHeader, '');
  assert.equal(sanitizedEmpty.hasWebhookSecret, false);
});
