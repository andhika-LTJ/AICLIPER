import { useEffect, useState } from 'react';
import {
  Activity,
  Building2,
  DatabaseBackup,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  XCircle,
} from 'lucide-react';
import type {
  AccountStatus,
  AdminOverviewData,
  PaymentProviderStatus,
  PlanTier,
  SystemSettingsData,
  UserRole,
  WorkspaceRecord,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';

type AdminTab = 'overview' | 'users' | 'workspaces' | 'ai_usage' | 'renders' | 'settings' | 'audit';

interface AdminControlCenterViewProps {
  currentUserRole: UserRole;
}

interface AdminUserRow {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  status: AccountStatus;
  planTier: PlanTier;
  episodesCount: number;
  clipsCount: number;
  lastLoginAt: string | null;
}

interface AdminRenderJobRow {
  id: string;
  userUid: string;
  clipId: string;
  status: string;
  stage: string;
  progress: number;
  layout: string;
  quality: string;
  errorMessage: string | null;
  createdAt: string;
}

interface AuditLogRow {
  id: string;
  actorUid: string;
  actorEmail: string | null;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
}

interface AiUsagePayload {
  summaryByOperation: Array<{
    operation: string;
    model: string;
    calls: number;
    tokens: number;
    costUsd: number;
  }>;
  summaryByUser: Array<{
    userUid: string;
    email: string | null;
    calls: number;
    tokens: number;
    costUsd: number;
  }>;
  recentCalls: Array<{
    id: string;
    userUid: string;
    operation: string;
    model: string;
    totalTokens: number;
    estimatedCostUsd: number;
    status: string;
    createdAt: string;
  }>;
}

interface ReadinessLayerStatus {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  operational: boolean;
  tested: boolean;
  mode?: string;
  error?: string | null;
}

interface ProductionReadinessData {
  phase?: string;
  deploymentPhase?: string;
  cloudRunServiceName?: string | null;
  allCloudResourcesProvisioned: boolean;
  database: ReadinessLayerStatus & {
    backend: string;
    activeMode: string;
    latencyMs: number | null;
  };
  auth: {
    adc: ReadinessLayerStatus;
    oidcDispatcherConfigured: boolean;
    staticGcpAccessTokenForbidden: boolean;
  };
  storage: ReadinessLayerStatus & { bucketName: string | null };
  queue: ReadinessLayerStatus & { oidcConfigured: boolean };
  renderWorker: ReadinessLayerStatus;
  workerRuntime?: ReadinessLayerStatus;
  runtimeResources?: {
    memoryRssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    cpuCount: number;
    loadAvg1m: number;
    uptimeSec: number;
    nodeVersion: string;
  };
  telemetry?: {
    lastSuccessfulRenderAt: string | null;
    avgQueueLatencyMs: number | null;
    avgDispatchLatencyMs: number | null;
    avgRenderDurationMs: number | null;
    avgUploadDurationMs: number | null;
    renderFailureCount: number;
    renderRetryCount: number;
    completedRenderCount: number;
    activeRenderCount: number;
    queuedRenderCount?: number;
    processingRenderCount?: number;
    recentErrors?: Array<{
      jobId: string;
      stage: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      updatedAt: string;
    }>;
  };
}

export function AdminControlCenterView({ currentUserRole }: AdminControlCenterViewProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [overview, setOverview] = useState<AdminOverviewData | null>(null);
  const [readiness, setReadiness] = useState<ProductionReadinessData | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [aiUsage, setAiUsage] = useState<AiUsagePayload | null>(null);
  const [renderJobs, setRenderJobs] = useState<AdminRenderJobRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [workspaces, setWorkspaces] = useState<Array<WorkspaceRecord & { ownerEmail?: string | null }>>([]);
  const [systemSettings, setSystemSettings] = useState<SystemSettingsData | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<PaymentProviderStatus | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isSuperAdmin = currentUserRole === 'super_admin';

  const loadTabData = async (tab: AdminTab) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      if (tab === 'overview') {
        const [res, readinessRes] = await Promise.all([
          apiFetch('/api/admin/overview'),
          apiFetch('/api/v3/readiness').catch(() => null),
        ]);
        if (!res.ok) throw new Error('Gagal memuat ringkasan admin.');
        setOverview((await res.json()) as AdminOverviewData);
        if (readinessRes && readinessRes.ok) {
          setReadiness((await readinessRes.json()) as ProductionReadinessData);
        }
      } else if (tab === 'users') {
        const res = await apiFetch(`/api/admin/users?search=${encodeURIComponent(userSearch)}`);
        if (!res.ok) throw new Error('Gagal memuat daftar pengguna.');
        const data = (await res.json()) as { users: AdminUserRow[] };
        setUsers(data.users ?? []);
      } else if (tab === 'workspaces') {
        const res = await apiFetch('/api/v2/admin/workspaces');
        if (!res.ok) throw new Error('Gagal memuat daftar workspace.');
        const data = (await res.json()) as {
          workspaces: Array<WorkspaceRecord & { ownerEmail?: string | null }>;
        };
        setWorkspaces(data.workspaces ?? []);
      } else if (tab === 'ai_usage') {
        const res = await apiFetch('/api/admin/ai-usage');
        if (!res.ok) throw new Error('Gagal memuat laporan AI usage.');
        setAiUsage((await res.json()) as AiUsagePayload);
      } else if (tab === 'renders') {
        const res = await apiFetch('/api/admin/render-jobs');
        if (!res.ok) throw new Error('Gagal memuat antrean render.');
        const data = (await res.json()) as { jobs: AdminRenderJobRow[] };
        setRenderJobs(data.jobs ?? []);
      } else if (tab === 'settings') {
        const res = await apiFetch('/api/v2/admin/system-settings');
        if (!res.ok) throw new Error('Gagal memuat pengaturan sistem.');
        const data = (await res.json()) as {
          settings: SystemSettingsData;
          paymentProvider: PaymentProviderStatus;
        };
        setSystemSettings(data.settings);
        setPaymentStatus(data.paymentProvider);
      } else if (tab === 'audit') {
        const res = await apiFetch('/api/admin/audit-logs');
        if (!res.ok) throw new Error('Gagal memuat audit log.');
        const data = (await res.json()) as { logs: AuditLogRow[] };
        setAuditLogs(data.logs ?? []);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat data admin.');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSystemSettings = async () => {
    if (!systemSettings || !isSuperAdmin) return;
    setIsSavingSettings(true);
    setErrorMsg(null);
    setFeedback(null);
    try {
      const res = await apiFetch('/api/v2/admin/system-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultAiModel: systemSettings.defaultAiModel,
          fallbackAiModel: systemSettings.fallbackAiModel,
          maintenanceMode: systemSettings.maintenanceMode,
          allowNewRegistrations: systemSettings.allowNewRegistrations,
          defaultThemePreset: systemSettings.defaultThemePreset,
          plans: systemSettings.plans,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: SystemSettingsData;
        error?: string;
      };
      if (!res.ok) {
        setErrorMsg(data.error || 'Gagal menyimpan pengaturan sistem.');
        return;
      }
      if (data.settings) setSystemSettings(data.settings);
      setFeedback('Pengaturan sistem & katalog paket berhasil disimpan dan dicatat ke Audit Log.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  useEffect(() => {
    void loadTabData(activeTab);
  }, [activeTab]);

  const handleUpdateUserStatus = async (uid: string, status: AccountStatus) => {
    const res = await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setErrorMsg(data.error || 'Gagal memperbarui status pengguna.');
      return;
    }
    setFeedback(`Status akun berhasil diubah menjadi ${status}.`);
    void loadTabData('users');
  };

  const handleUpdateUserPlan = async (uid: string, planTier: PlanTier) => {
    const res = await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/plan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setErrorMsg(data.error || 'Gagal memperbarui paket pengguna.');
      return;
    }
    setFeedback(`Paket pengguna diperbarui ke ${planTier.toUpperCase()}.`);
    void loadTabData('users');
  };

  const handleUpdateUserRole = async (uid: string, role: UserRole) => {
    const res = await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setErrorMsg(data.error || 'Gagal memperbarui role pengguna.');
      return;
    }
    setFeedback(`Role pengguna diperbarui ke ${role}.`);
    void loadTabData('users');
  };

  const handleCreateBackup = async () => {
    const res = await apiFetch('/api/admin/backup', { method: 'POST' });
    const data = (await res.json().catch(() => ({}))) as {
      fileName?: string;
      backupFile?: string;
      error?: string;
    };
    if (!res.ok) {
      setErrorMsg(data.error || 'Gagal membuat backup database.');
      return;
    }
    setFeedback(`Backup snapshot database berhasil dibuat: ${data.fileName || data.backupFile || 'berhasil'}`);
  };

  const handleCancelRenderJob = async (jobId: string) => {
    const res = await apiFetch(`/api/admin/render-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
    if (res.ok) {
      setFeedback(`Job render ${jobId} berhasil dibatalkan.`);
      void loadTabData('renders');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-red-600">
            Admin Control Center · Role: {currentUserRole}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white mt-0.5">
            Monitoring Sistem, Pengguna & Keamanan
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Seluruh angka dibaca langsung dari database SQLite, OS/Node runtime, dan log aktivitas aktual server.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => void handleCreateBackup()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              <DatabaseBackup className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Buat Snapshot Backup DB</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadTabData(activeTab)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Muat Ulang</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Menu kontrol admin"
        className="flex flex-wrap items-center gap-1.5 p-1.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl"
      >
        {(
          [
            { id: 'overview', label: 'Overview & Kesehatan', icon: Activity },
            { id: 'users', label: 'Manajemen Pengguna', icon: Users },
            { id: 'workspaces', label: 'Workspaces', icon: Building2 },
            { id: 'ai_usage', label: 'AI Usage & Biaya', icon: Sparkles },
            { id: 'renders', label: 'Monitoring Render', icon: Video },
            { id: 'settings', label: 'Paket & Sistem', icon: Settings2 },
            { id: 'audit', label: 'Audit Log', icon: ShieldCheck },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(tab.id);
                setFeedback(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg cursor-pointer ${
                active
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {feedback && (
        <div role="status" className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-xs font-medium text-emerald-800 dark:text-emerald-200">
          {feedback}
        </div>
      )}
      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs font-medium text-red-700 dark:text-red-200">
          {errorMsg}
        </div>
      )}

      {/* TAB: OVERVIEW */}
      {activeTab === 'overview' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ['Total Pengguna', `${overview.users.total} (${overview.users.activeLast7Days} aktif 7h)`],
              ['Total Episode & Klip', `${overview.content.totalEpisodes} ep · ${overview.content.totalClips} klip`],
              ['Job Render', `${overview.renders.completed} sukses · ${overview.renders.failed} gagal`],
              ['Estimasi Biaya AI', `$${overview.ai.estimatedCostUsd.toFixed(4)} (${overview.ai.totalRequests} req)`],
            ].map(([label, val]) => (
              <div
                key={label}
                className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1"
              >
                <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
                <div className="font-display text-lg font-bold text-slate-900 dark:text-white font-mono tabular-nums">
                  {val}
                </div>
              </div>
            ))}
          </div>

          <section className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Kesehatan Runtime & Penyimpanan Server
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">Node.js & Uptime</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                  {overview.system.nodeVersion} · {Math.floor(overview.system.uptimeSec / 60)}m
                </div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">Memori Proses (RSS / Heap)</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                  {overview.system.memoryRssMb} MB RSS · {overview.system.heapUsedMb} MB Heap
                </div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">FFmpeg / Gemini Key</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                  FFmpeg: {overview.system.ffmpegReady ? 'OK' : 'N/A'} · Gemini:{' '}
                  {overview.system.geminiConfigured ? 'Aktif' : 'Belum'}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">Storage & DB</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                  Media {Math.round((overview.storage.rendersDirBytes + overview.storage.uploadsDirBytes) / (1024 * 1024))} MB · Data{' '}
                  {Math.round(overview.storage.dataDirBytes / (1024 * 1024))} MB ({overview.system.dbStatus})
                </div>
              </div>
            </div>
          </section>

          {readiness && (
            <section className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                    Kesiapan Infrastruktur Production (Fase {readiness.deploymentPhase || readiness.phase || '0C'})
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Status diverifikasi langsung dari probe koneksi aktual — bukan hanya keberadaan env var.
                  </p>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold ${
                    readiness.allCloudResourcesProvisioned
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                      : 'bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800'
                  }`}
                >
                  {readiness.allCloudResourcesProvisioned
                    ? 'Cloud Production Operational'
                    : 'Staged / Fallback Mode (Belum Semua Cloud Aktif)'}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                      <th className="py-2 pr-3 font-semibold">Komponen</th>
                      <th className="py-2 px-2 font-semibold">Mode</th>
                      <th className="py-2 px-2 font-semibold">Configured</th>
                      <th className="py-2 px-2 font-semibold">Auth</th>
                      <th className="py-2 px-2 font-semibold">Connected</th>
                      <th className="py-2 px-2 font-semibold">Operational</th>
                      <th className="py-2 pl-2 font-semibold">Tested</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(
                      [
                        ['PostgreSQL / Cloud SQL', readiness.database, readiness.database.activeMode],
                        ['Google Cloud Storage', readiness.storage, readiness.storage.mode || 'local_fallback'],
                        ['Cloud Tasks (OIDC)', readiness.queue, readiness.queue.mode || 'local_fallback'],
                        ['Cloud Run Jobs', readiness.renderWorker, readiness.renderWorker.mode || 'local_worker_fallback'],
                        ['Google ADC Identity', readiness.auth.adc, readiness.auth.adc.mode || 'adc_unavailable'],
                        ...(readiness.workerRuntime
                          ? [['Render Worker Runtime', readiness.workerRuntime, readiness.workerRuntime.mode || 'local_worker_fallback'] as const]
                          : []),
                      ] as Array<readonly [string, ReadinessLayerStatus, string]>
                    ).map(([label, layer, modeLabel]) => {
                      const cell = (val: boolean) => (
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold ${
                            val
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                          }`}
                        >
                          {val ? 'YA' : 'TIDAK'}
                        </span>
                      );
                      return (
                        <tr key={label}>
                          <td className="py-2.5 pr-3 font-medium text-slate-900 dark:text-white">
                            {label}
                            {layer.error && !layer.operational && (
                              <div className="text-[11px] font-normal text-slate-500 dark:text-slate-400 mt-0.5 max-w-md truncate">
                                {layer.error}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-2 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                            {modeLabel}
                          </td>
                          <td className="py-2.5 px-2">{cell(layer.configured)}</td>
                          <td className="py-2.5 px-2">{cell(layer.authenticated)}</td>
                          <td className="py-2.5 px-2">{cell(layer.connected)}</td>
                          <td className="py-2.5 px-2">{cell(layer.operational)}</td>
                          <td className="py-2.5 pl-2">{cell(layer.tested)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {readiness.telemetry && (
                <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500">Antrean / Processing</div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                        {readiness.telemetry.queuedRenderCount ?? 0} queued ·{' '}
                        {readiness.telemetry.processingRenderCount ?? readiness.telemetry.activeRenderCount} aktif
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500">Avg Queue / Dispatch</div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                        {readiness.telemetry.avgQueueLatencyMs ?? '—'} ms /{' '}
                        {readiness.telemetry.avgDispatchLatencyMs ?? '—'} ms
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500">Avg Render / Upload</div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                        {readiness.telemetry.avgRenderDurationMs ?? '—'} ms /{' '}
                        {readiness.telemetry.avgUploadDurationMs ?? '—'} ms
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500">Sukses / Gagal / Retry</div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                        {readiness.telemetry.completedRenderCount} ok · {readiness.telemetry.renderFailureCount} gagal ·{' '}
                        {readiness.telemetry.renderRetryCount} retry
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500">Render Sukses Terakhir & Resource</div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                        {readiness.telemetry.lastSuccessfulRenderAt
                          ? new Date(readiness.telemetry.lastSuccessfulRenderAt).toLocaleString('id-ID')
                          : 'Belum ada'}
                        {readiness.runtimeResources && (
                          <span className="block text-[11px] font-normal text-slate-500 mt-0.5">
                            RSS {readiness.runtimeResources.memoryRssMb} MB · Heap {readiness.runtimeResources.heapUsedMb}/
                            {readiness.runtimeResources.heapTotalMb} MB · {readiness.runtimeResources.cpuCount} vCPU · Load{' '}
                            {readiness.runtimeResources.loadAvg1m}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500">Error Render Terbaru</div>
                      {readiness.telemetry.recentErrors && readiness.telemetry.recentErrors.length > 0 ? (
                        <ul className="mt-1 space-y-1">
                          {readiness.telemetry.recentErrors.slice(0, 3).map((errItem) => (
                            <li
                              key={`${errItem.jobId}-${errItem.updatedAt}`}
                              className="text-[11px] font-mono text-red-700 dark:text-red-300 truncate"
                            >
                              {errItem.jobId.slice(0, 12)} [{errItem.errorCode || errItem.stage || 'ERROR'}]:{' '}
                              {errItem.errorMessage || 'Gagal diproses'}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5">
                          Tidak ada error render terbaru.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* TAB: USERS */}
      {activeTab === 'users' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Cari email atau nama pengguna..."
              className="h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg w-64"
            />
            <button
              type="button"
              onClick={() => void loadTabData('users')}
              className="h-9 px-3 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 rounded-lg cursor-pointer"
            >
              Cari
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">
                  <th className="py-3 px-4">Pengguna</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Paket</th>
                  <th className="py-3 px-4">Konten</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Kontrol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {users.map((u) => (
                  <tr key={u.uid}>
                    <td className="py-2.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {u.displayName || 'Tanpa Nama'}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">{u.email || u.uid}</div>
                    </td>
                    <td className="py-2.5 px-4">
                      {isSuperAdmin ? (
                        <select
                          aria-label={`Ubah role ${u.email || u.uid}`}
                          value={u.role}
                          onChange={(e) => void handleUpdateUserRole(u.uid, e.target.value as UserRole)}
                          className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                          <option value="super_admin">super_admin</option>
                        </select>
                      ) : (
                        <span className="font-mono font-semibold">{u.role}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <select
                        aria-label={`Ubah paket ${u.email || u.uid}`}
                        value={u.planTier}
                        onChange={(e) => void handleUpdateUserPlan(u.uid, e.target.value as PlanTier)}
                        className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value="free">free</option>
                        <option value="starter">starter</option>
                        <option value="pro">pro</option>
                        <option value="business">business</option>
                      </select>
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums">
                      {u.episodesCount} ep / {u.clipsCount} klip
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded font-semibold ${
                          u.status === 'active'
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                            : 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      {u.role !== 'super_admin' && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleUpdateUserStatus(
                              u.uid,
                              u.status === 'active' ? 'suspended' : 'active'
                            )
                          }
                          className="px-2.5 py-1 rounded text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-red-600 hover:text-white cursor-pointer"
                        >
                          {u.status === 'active' ? 'Tangguhkan' : 'Aktifkan'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB: AI USAGE */}
      {activeTab === 'ai_usage' && aiUsage && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Ringkasan per Operasi & Model AI
            </h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {aiUsage.summaryByOperation.length === 0 ? (
                <p className="text-slate-500">Belum ada panggilan API AI tercatat.</p>
              ) : (
                aiUsage.summaryByOperation.map((row, i) => (
                  <div key={i} className="py-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">{row.operation}</div>
                      <div className="text-[11px] font-mono text-slate-500">{row.model}</div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div>{row.calls} req · {row.tokens.toLocaleString('id-ID')} tok</div>
                      <div className="text-emerald-700 dark:text-emerald-400">${row.costUsd.toFixed(5)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Konsumsi AI per Pengguna
            </h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {aiUsage.summaryByUser.length === 0 ? (
                <p className="text-slate-500">Belum ada konsumsi AI tercatat.</p>
              ) : (
                aiUsage.summaryByUser.map((row) => (
                  <div key={row.userUid} className="py-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
                      {row.email || row.userUid}
                    </span>
                    <span className="font-mono tabular-nums shrink-0">
                      {row.calls} req · ${row.costUsd.toFixed(5)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* TAB: RENDER JOBS */}
      {activeTab === 'renders' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-3 px-4">Job ID</th>
                  <th className="py-3 px-4">Format</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Tahap</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {renderJobs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      Belum ada riwayat job render.
                    </td>
                  </tr>
                ) : (
                  renderJobs.map((job) => (
                    <tr key={job.id}>
                      <td className="py-2.5 px-4 font-mono">{job.id.slice(0, 14)}</td>
                      <td className="py-2.5 px-4">{job.layout} · {job.quality}</td>
                      <td className="py-2.5 px-4 font-semibold">{job.status} ({job.progress}%)</td>
                      <td className="py-2.5 px-4 max-w-md truncate">{job.errorMessage || job.stage}</td>
                      <td className="py-2.5 px-4 text-right">
                        {(job.status === 'queued' || job.status === 'running') && (
                          <button
                            type="button"
                            onClick={() => void handleCancelRenderJob(job.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-red-600 text-white font-semibold cursor-pointer"
                          >
                            <XCircle className="w-3 h-3" aria-hidden="true" />
                            <span>Hentikan</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB: WORKSPACES */}
      {activeTab === 'workspaces' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-3 px-4">Workspace</th>
                  <th className="py-3 px-4">Pemilik</th>
                  <th className="py-3 px-4">Anggota</th>
                  <th className="py-3 px-4">Proyek Editor</th>
                  <th className="py-3 px-4">Dibuat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {workspaces.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      Belum ada workspace terdaftar.
                    </td>
                  </tr>
                ) : (
                  workspaces.map((ws) => (
                    <tr key={ws.id}>
                      <td className="py-2.5 px-4 font-semibold text-slate-900 dark:text-white">
                        {ws.name}
                        <span className="block text-[11px] font-mono text-slate-500">{ws.slug}</span>
                      </td>
                      <td className="py-2.5 px-4">{ws.ownerEmail || ws.ownerUid}</td>
                      <td className="py-2.5 px-4 font-mono tabular-nums">{ws.memberCount ?? 1}</td>
                      <td className="py-2.5 px-4 font-mono tabular-nums">{ws.projectCount ?? 0}</td>
                      <td className="py-2.5 px-4 font-mono whitespace-nowrap">
                        {new Date(ws.createdAt).toLocaleDateString('id-ID')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB: SYSTEM SETTINGS & CONFIGURABLE PLANS */}
      {activeTab === 'settings' && systemSettings && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Pengaturan Sistem, Model AI & Katalog Paket SaaS
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {isSuperAdmin
                  ? 'Sebagai Super Admin, Anda dapat mengubah harga paket dan konfigurasi platform secara langsung (diaudit).'
                  : 'Mode baca-saja: Hanya Super Admin yang dapat mengubah konfigurasi sistem global.'}
              </p>
            </div>
            {isSuperAdmin && (
              <button
                type="button"
                disabled={isSavingSettings}
                onClick={() => void handleSaveSystemSettings()}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
              >
                {isSavingSettings ? 'Menyimpan...' : 'Simpan Pengaturan Sistem'}
              </button>
            )}
          </div>

          {paymentStatus && (
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="font-semibold text-slate-900 dark:text-white">
                Status Payment Gateway: {paymentStatus.configured ? `${paymentStatus.provider} (${paymentStatus.mode})` : 'Belum Dikonfigurasi (Manual Admin)'}
              </div>
              <p className="text-slate-600 dark:text-slate-400">{paymentStatus.message}</p>
              <p className="font-mono text-[11px] text-slate-500">
                Env yang dibutuhkan: {paymentStatus.requiredEnvVars.join(' · ')}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="sys-ai-model" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Model AI Utama
              </label>
              <select
                id="sys-ai-model"
                disabled={!isSuperAdmin}
                value={systemSettings.defaultAiModel}
                onChange={(e) =>
                  setSystemSettings((prev) =>
                    prev ? { ...prev, defaultAiModel: e.target.value } : prev
                  )
                }
                className="w-full h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg disabled:opacity-60"
              >
                <option value="gemini-4-hydrogen">gemini-4-hydrogen (Primary)</option>
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Hemat)</option>
              </select>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 pt-5">
              <input
                type="checkbox"
                disabled={!isSuperAdmin}
                checked={systemSettings.allowNewRegistrations}
                onChange={(e) =>
                  setSystemSettings((prev) =>
                    prev ? { ...prev, allowNewRegistrations: e.target.checked } : prev
                  )
                }
                className="accent-red-600"
              />
              <span>Izinkan Pendaftaran Pengguna Baru</span>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 pt-5">
              <input
                type="checkbox"
                disabled={!isSuperAdmin}
                checked={systemSettings.maintenanceMode}
                onChange={(e) =>
                  setSystemSettings((prev) =>
                    prev ? { ...prev, maintenanceMode: e.target.checked } : prev
                  )
                }
                className="accent-red-600"
              />
              <span>Mode Pemeliharaan (Maintenance)</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
            {(['free', 'starter', 'pro', 'business'] as PlanTier[]).map((tier) => {
              const item = systemSettings.plans[tier];
              if (!item) return null;
              return (
                <div
                  key={tier}
                  className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2"
                >
                  <div className="text-xs font-bold uppercase text-slate-900 dark:text-white">
                    {item.label}
                  </div>
                  <div>
                    <label
                      htmlFor={`plan-price-${tier}`}
                      className="block text-[11px] text-slate-500 mb-1"
                    >
                      Harga Bulanan (IDR)
                    </label>
                    <input
                      id={`plan-price-${tier}`}
                      type="number"
                      min={0}
                      step={1000}
                      disabled={!isSuperAdmin}
                      value={item.monthlyPriceIdr}
                      onChange={(e) => {
                        const val = Math.max(0, Number(e.target.value) || 0);
                        setSystemSettings((prev) =>
                          prev
                            ? {
                                ...prev,
                                plans: {
                                  ...prev.plans,
                                  [tier]: { ...prev.plans[tier], monthlyPriceIdr: val },
                                },
                              }
                            : prev
                        );
                      }}
                      className="w-full h-8 px-2 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded disabled:opacity-60"
                    />
                  </div>
                  <div className="text-[11px] font-mono text-slate-500">
                    AI {item.monthlyAiLimit}/bln · Render {item.monthlyRenderLimit}/bln · {item.maxExportQuality.toUpperCase()}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* TAB: AUDIT LOGS */}
      {activeTab === 'audit' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Aktor</th>
                  <th className="py-3 px-4">Aksi</th>
                  <th className="py-3 px-4">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500">
                      Belum ada catatan audit log.
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="py-2.5 px-4 font-mono whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString('id-ID')}
                      </td>
                      <td className="py-2.5 px-4">
                        {log.actorEmail || log.actorUid} ({log.actorRole})
                      </td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-red-600 dark:text-red-400">
                        {log.action}
                      </td>
                      <td className="py-2.5 px-4 font-mono">
                        {log.targetType}
                        {log.targetId ? `:${log.targetId.slice(0, 12)}` : ''}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
