import fs from 'fs';
import os from 'os';
import path from 'path';

export interface AssFontEnvironment {
  fontsDir: string;
  fontconfigFile: string;
  fontName: string;
}

const FONTCONFIG_DIR = path.join(os.tmpdir(), 'klipcast-fontconfig');
const FONTCONFIG_CACHE_DIR = path.join(FONTCONFIG_DIR, 'cache');
const FONTCONFIG_FILE = path.join(FONTCONFIG_DIR, 'fonts.conf');

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasTrueTypeFont(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) return false;
    const entries = fs.readdirSync(dirPath);
    return entries.some((name) => /\.(ttf|otf)$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Pure helper: constructs a minimal standalone Fontconfig XML pointing exclusively
 * to our bundled font directory + writable temp cache directory so libass never fails
 * with "Cannot load default config file" on minimal Cloud Run slim containers.
 */
export function buildMinimalFontconfigXml(fontsDir: string, cacheDir: string): string {
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    '<fontconfig>',
    `  <dir>${escapeXml(fontsDir)}</dir>`,
    `  <cachedir>${escapeXml(cacheDir)}</cachedir>`,
    '  <alias>',
    '    <family>sans-serif</family>',
    '    <prefer><family>Liberation Sans</family><family>DejaVu Sans</family></prefer>',
    '  </alias>',
    '  <alias>',
    '    <family>serif</family>',
    '    <prefer><family>Liberation Serif</family><family>DejaVu Serif</family></prefer>',
    '  </alias>',
    '  <alias>',
    '    <family>monospace</family>',
    '    <prefer><family>Liberation Mono</family><family>DejaVu Sans Mono</family></prefer>',
    '  </alias>',
    '</fontconfig>',
    '',
  ].join('\n');
}

/**
 * Resolves the bundled server/fonts directory first (ships LiberationSans Regular & Bold, ~271 KB),
 * falling back cleanly to system Liberation or DejaVu fonts if present.
 */
export function resolveBundledFontDirectory(cwd = process.cwd()): {
  fontsDir: string;
  fontName: string;
} {
  const candidates: Array<{ dir: string; fontName: string }> = [
    { dir: path.resolve(cwd, 'server', 'fonts'), fontName: 'Liberation Sans' },
    { dir: '/usr/share/fonts/truetype/liberation', fontName: 'Liberation Sans' },
    { dir: '/usr/share/fonts/truetype/dejavu', fontName: 'DejaVu Sans' },
  ];

  for (const candidate of candidates) {
    if (hasTrueTypeFont(candidate.dir)) {
      return { fontsDir: candidate.dir, fontName: candidate.fontName };
    }
  }

  return {
    fontsDir: path.resolve(cwd, 'server', 'fonts'),
    fontName: 'Liberation Sans',
  };
}

let cachedEnv: AssFontEnvironment | null = null;

/**
 * Ensures bundled TrueType fonts + standalone fontconfig XML are ready on disk
 * before invoking FFmpeg's libass (`ass=...:fontsdir=...`).
 */
export function ensureAssFontEnvironment(): AssFontEnvironment {
  if (
    cachedEnv &&
    fs.existsSync(cachedEnv.fontconfigFile) &&
    hasTrueTypeFont(cachedEnv.fontsDir)
  ) {
    return cachedEnv;
  }

  const { fontsDir, fontName } = resolveBundledFontDirectory();
  fs.mkdirSync(FONTCONFIG_CACHE_DIR, { recursive: true });
  const xml = buildMinimalFontconfigXml(fontsDir, FONTCONFIG_CACHE_DIR);
  fs.writeFileSync(FONTCONFIG_FILE, xml, 'utf-8');

  cachedEnv = {
    fontsDir,
    fontconfigFile: FONTCONFIG_FILE,
    fontName,
  };
  return cachedEnv;
}
