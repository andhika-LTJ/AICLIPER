import type {
  PaymentProviderStatus,
  PlanCatalogItem,
  PlanTier,
  SystemSettingsData,
} from '../../src/types/clipper.ts';

export interface CheckoutSessionRequest {
  userUid: string;
  userEmail: string | null;
  planTier: PlanTier;
  amountIdr: number;
  returnUrl: string;
}

export interface CheckoutSessionResult {
  supported: boolean;
  provider: string;
  checkoutUrl?: string;
  referenceCode?: string;
  message: string;
}

/**
 * Pluggable PaymentProvider abstraction for AICLIPER 2.0.
 * Never fabricates live checkout transactions when gateway credentials are missing.
 */
export interface PaymentProvider {
  readonly name: string;
  getStatus(): PaymentProviderStatus;
  createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSessionResult>;
}

export class UnconfiguredPaymentProvider implements PaymentProvider {
  readonly name = 'unconfigured';

  getStatus(): PaymentProviderStatus {
    return {
      provider: 'none',
      configured: false,
      mode: 'unconfigured',
      supportedMethods: ['QRIS (Midtrans/Xendit)', 'Virtual Account', 'Kartu Kredit (Stripe)'],
      requiredEnvVars: [
        'PAYMENT_PROVIDER (midtrans | xendit | stripe)',
        'PAYMENT_SERVER_KEY',
        'PAYMENT_WEBHOOK_SECRET',
      ],
      message:
        'Payment gateway belum dikonfigurasi pada server ini. Perubahan paket saat ini dikelola manual oleh Super Admin dan dicatat di riwayat billing.',
    };
  }

  async createCheckoutSession(): Promise<CheckoutSessionResult> {
    return {
      supported: false,
      provider: 'none',
      message:
        'Checkout otomatis belum aktif karena kredensial payment gateway (PAYMENT_PROVIDER & PAYMENT_SERVER_KEY) belum dipasang di environment server.',
    };
  }
}

export class ConfiguredGatewayStubProvider implements PaymentProvider {
  readonly name: string;
  private readonly mode: 'sandbox' | 'live';

  constructor(providerName: string, mode: 'sandbox' | 'live') {
    this.name = providerName;
    this.mode = mode;
  }

  getStatus(): PaymentProviderStatus {
    return {
      provider: this.name,
      configured: true,
      mode: this.mode,
      supportedMethods: ['QRIS', 'Virtual Account', 'E-Wallet', 'Kartu Kredit'],
      requiredEnvVars: ['PAYMENT_PROVIDER', 'PAYMENT_SERVER_KEY', 'PAYMENT_WEBHOOK_SECRET'],
      message: `Konfigurasi environment ${this.name} (${this.mode}) terdeteksi. Hubungkan webhook verifikasi untuk mengaktifkan upgrade otomatis.`,
    };
  }

  async createCheckoutSession(req: CheckoutSessionRequest): Promise<CheckoutSessionResult> {
    return {
      supported: false,
      provider: this.name,
      message: `Adapter SDK ${this.name} siap disambungkan untuk paket ${req.planTier}. Verifikasi webhook server-side diperlukan sebelum memproses transaksi nyata.`,
    };
  }
}

export function resolvePaymentProvider(): PaymentProvider {
  const rawProvider = (process.env.PAYMENT_PROVIDER ?? '').trim().toLowerCase();
  const hasServerKey = Boolean((process.env.PAYMENT_SERVER_KEY ?? '').trim());
  const mode = (process.env.PAYMENT_MODE ?? 'sandbox').trim().toLowerCase() === 'live'
    ? 'live'
    : 'sandbox';

  if (
    hasServerKey &&
    (rawProvider === 'midtrans' || rawProvider === 'xendit' || rawProvider === 'stripe')
  ) {
    return new ConfiguredGatewayStubProvider(rawProvider, mode);
  }
  return new UnconfiguredPaymentProvider();
}

export const DEFAULT_PLAN_CATALOG: Record<PlanTier, PlanCatalogItem> = {
  free: {
    tier: 'free',
    label: 'Free',
    monthlyPriceIdr: 0,
    monthlyAiLimit: 25,
    monthlyRenderLimit: 15,
    monthlyUploadLimit: 15,
    maxExportQuality: '1080p',
    maxStorageMb: 1024,
    maxProjects: 15,
    highlights: [
      '25 analisis & generasi AI / bulan',
      '15 render MP4 Full HD 1080p',
      'Smart Video Editor & AI Subtitle Studio',
      '1 GB penyimpanan proyek',
    ],
  },
  starter: {
    tier: 'starter',
    label: 'Starter',
    monthlyPriceIdr: 149000,
    monthlyAiLimit: 120,
    monthlyRenderLimit: 60,
    monthlyUploadLimit: 60,
    maxExportQuality: '1080p',
    maxStorageMb: 5120,
    maxProjects: 60,
    highlights: [
      '120 analisis & generasi AI / bulan',
      '60 render MP4 Full HD 1080p',
      'Pustaka Template & AI Content Advisor',
      '5 GB penyimpanan proyek',
    ],
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    monthlyPriceIdr: 349000,
    monthlyAiLimit: 500,
    monthlyRenderLimit: 250,
    monthlyUploadLimit: 250,
    maxExportQuality: '4k',
    maxStorageMb: 20480,
    maxProjects: 250,
    highlights: [
      '500 analisis & generasi AI / bulan',
      '250 render hingga Ultra HD 4K',
      'Sinkronisasi Analitik YouTube & AI Growth',
      '20 GB penyimpanan proyek',
    ],
  },
  business: {
    tier: 'business',
    label: 'Business',
    monthlyPriceIdr: 899000,
    monthlyAiLimit: 2500,
    monthlyRenderLimit: 1000,
    monthlyUploadLimit: 1000,
    maxExportQuality: '4k',
    maxStorageMb: 102400,
    maxProjects: 1000,
    highlights: [
      '2.500 analisis & generasi AI / bulan',
      '1.000 render Ultra HD 4K prioritas',
      'Multi-Workspace & kontrol tim lengkap',
      '100 GB penyimpanan proyek',
    ],
  },
};

export function createDefaultSystemSettings(): SystemSettingsData {
  return {
    defaultAiModel: 'gemini-4-hydrogen',
    fallbackAiModel: 'gemini-3.1-flash-lite',
    maintenanceMode: false,
    allowNewRegistrations: true,
    defaultThemePreset: 'minimal_light',
    plans: structuredClone(DEFAULT_PLAN_CATALOG),
    updatedAt: new Date().toISOString(),
  };
}
