import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import type { AppNotification } from '../types/clipper';
import { apiFetch } from '../utils/apiClient';

interface NotificationCenterProps {
  isAuthenticated: boolean;
}

export function NotificationCenter({ isAuthenticated }: NotificationCenterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const loadNotifications = async () => {
    if (!isAuthenticated) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    try {
      const res = await apiFetch('/api/notifications');
      if (!res.ok) return;
      const data = (await res.json()) as {
        notifications?: AppNotification[];
        unreadCount?: number;
      };
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      // Ignore transient notification fetch failures
    }
  };

  useEffect(() => {
    void loadNotifications();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isOpen) return;
    void loadNotifications();
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleMarkRead = async (id: string) => {
    if (!isAuthenticated) return;
    const res = await apiFetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
    });
    if (res.ok) {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
  };

  const handleMarkAllRead = async () => {
    if (!isAuthenticated) return;
    const res = await apiFetch('/api/notifications/read-all', { method: 'POST' });
    if (res.ok) {
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={`Notifikasi${unreadCount > 0 ? ` (${unreadCount} belum dibaca)` : ''}`}
        aria-expanded={isOpen}
        className="relative p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 studio-transition cursor-pointer"
      >
        <Bell className="w-4 h-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-[10px] font-bold text-white flex items-center justify-center font-mono tabular-nums">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="region"
          aria-label="Pusat notifikasi"
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden z-40"
        >
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <span className="font-display text-xs font-bold text-slate-900 dark:text-white">
              Notifikasi Aktivitas
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void handleMarkAllRead()}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:text-red-700 cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Tandai semua dibaca</span>
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
            {!isAuthenticated ? (
              <p className="p-4 text-xs text-slate-500 dark:text-slate-400">
                Masuk dengan akun Google untuk melihat notifikasi render, kuota, dan publikasi cloud Anda.
              </p>
            ) : notifications.length === 0 ? (
              <p className="p-4 text-xs text-slate-500 dark:text-slate-400">
                Belum ada notifikasi baru. Aktivitas render MP4, kuota, dan upload YouTube akan muncul di sini.
              </p>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`p-3.5 space-y-1 ${
                    n.isRead ? 'bg-white dark:bg-slate-900' : 'bg-red-50/40 dark:bg-red-950/20'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white leading-snug">
                      {n.title}
                    </span>
                    {!n.isRead && (
                      <button
                        type="button"
                        onClick={() => void handleMarkRead(n.id)}
                        className="text-[10px] font-semibold text-red-600 hover:underline shrink-0 cursor-pointer"
                      >
                        Baca
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                    {n.message}
                  </p>
                  <div className="text-[10px] font-mono tabular-nums text-slate-400">
                    {new Date(n.createdAt).toLocaleString('id-ID', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
