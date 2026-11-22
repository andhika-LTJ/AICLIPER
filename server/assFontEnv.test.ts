import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  buildMinimalFontconfigXml,
  ensureAssFontEnvironment,
  resolveBundledFontDirectory,
} from './assFontEnv';

test('resolveBundledFontDirectory locates bundled Liberation Sans fonts inside server/fonts', () => {
  const resolved = resolveBundledFontDirectory();
  assert.ok(fs.existsSync(resolved.fontsDir), `Expected fontsDir to exist: ${resolved.fontsDir}`);
  const files = fs.readdirSync(resolved.fontsDir);
  assert.ok(
    files.some((f) => f.endsWith('.ttf')),
    'Expected at least one bundled .ttf font file for zero-font Cloud Run containers'
  );
  assert.equal(resolved.fontName, 'Liberation Sans');
});

test('buildMinimalFontconfigXml generates valid XML referencing fontsDir and cacheDir', () => {
  const xml = buildMinimalFontconfigXml('/app/server/fonts', '/tmp/fc-cache');
  assert.ok(xml.includes('<fontconfig>'));
  assert.ok(xml.includes('<dir>/app/server/fonts</dir>'));
  assert.ok(xml.includes('<cachedir>/tmp/fc-cache</cachedir>'));
  assert.ok(xml.includes('Liberation Sans'));
});

test('ensureAssFontEnvironment writes standalone fonts.conf on disk', () => {
  const env = ensureAssFontEnvironment();
  assert.ok(fs.existsSync(env.fontconfigFile));
  const content = fs.readFileSync(env.fontconfigFile, 'utf-8');
  assert.ok(content.includes(env.fontsDir));
});
