# Panduan Operasional Admin & Super Admin (`ADMIN_GUIDE.md`)

KlipCast menyediakan **Admin Control Center** terintegrasi yang hanya dapat diakses oleh akun dengan peran `admin` atau `super_admin` yang terverifikasi di backend.

## 1. Struktur Peran & Hak Akses

| Aksi | `user` | `admin` | `super_admin` |
| --- | :---: | :---: | :---: |
| Akses Studio Klip, Dashboard, AI Studio, Distribusi milik sendiri | Ya | Ya | Ya |
| Akses tab **Admin** & Monitoring Kesehatan Server | Tidak | Ya | Ya |
| Melihat daftar pengguna, pemakaian AI, render jobs, dan audit logs | Tidak | Ya | Ya |
| Menangguhkan / mengaktifkan ulang akun pengguna biasa | Tidak | Ya | Ya |
| Membatalkan render job lintas pengguna | Tidak | Ya | Ya |
| Mengelola `cookies.txt` YouTube server | Tidak | Ya | Ya |
| Mengubah peran pengguna (`user` / `admin` / `super_admin`) | Tidak | Tidak | **Ya** |
| Mengubah paket langganan & batas kuota pengguna | Tidak | Tidak | **Ya** |
| Membuat Snapshot Backup Database (`POST /api/admin/backup`) | Tidak | Tidak | **Ya** |

## 2. Mengatur Super Admin & Admin Awal

1. Secara default, email Super Admin awal dapat dikonfigurasi melalui variabel lingkungan `SUPER_ADMIN_EMAILS` (dipisahkan koma).
2. Saat pemilik email tersebut masuk pertama kali melalui Google Sign-In, sistem otomatis:
   - Mempromosikan akun ke peran `super_admin`.
   - Mengklaim proyek legacy hasil migrasi `clipper-store.json` (jika ada) agar tidak hilang.
3. Setelah masuk, Super Admin dapat mempromosikan pengguna lain menjadi `admin` langsung dari tab **Admin -> Pengguna** tanpa perlu mengubah file konfigurasi.

## 3. Paket Langganan & Batas Kuota Default

| Paket | Analisis AI / Bln | Render / Bln | Unggah / Bln | Storage Maks | Kualitas Maks | Maks Proyek |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `free` | 25 | 15 | 15 | 1.024 MB | 1080p | 15 |
| `starter` | 100 | 60 | 60 | 4.096 MB | 1080p | 50 |
| `pro` | 400 | 250 | 250 | 16.384 MB | **4K** | 200 |
| `business` | 2.000 | 1.000 | 1.000 | 65.536 MB | **4K** | 1.000 |

- Saat penggunaan mencapai >= 80%, pengguna otomatis menerima notifikasi peringatan di ikon lonceng.
- Saat kuota habis, backend menolak aksi baru dengan kode `403 QUOTA_EXCEEDED`.

## 4. Prosedur Operasional Rutin

### Memantau Kesehatan Server & Render Queue
- Buka **Admin -> Ringkasan & Sistem** untuk melihat penggunaan RAM aktual, uptime proses Node.js, status FFmpeg, total pengguna aktif, dan ringkasan biaya estimasi Gemini API.
- Jika terdapat proses render yang terlalu lama atau macet, buka **Admin -> Render Jobs** lalu klik **Batalkan** untuk menghentikan proses FFmpeg secara bersih.

### Membuat Backup Database Berkala
- Buka **Admin -> Ringkasan & Sistem** (khusus Super Admin) lalu klik **Buat Backup Database**.
- File snapshot tersimpan aman di `data/backups/klipcast-backup-<timestamp>.sqlite`.

### Memeriksa Jejak Audit (`Audit Logs`)
- Setiap perubahan status pengguna, perubahan peran, perubahan paket langganan, pembaruan pengaturan sistem/paket, pembatalan render paksa, pengelolaan `cookies.txt`, dan pembuatan backup otomatis tercatat pada **Admin -> Audit Log** beserta stempel waktu, pelaku, target, dan alamat IP.

## 5. Fitur Baru Admin Control Center 2.0

- **Tab Workspaces**: Admin & Super Admin dapat meninjau seluruh workspace proyek yang dibuat pengguna beserta pemilik dan jumlah anggotanya (`GET /api/v2/admin/workspaces`).
- **Tab Paket & Sistem**:
  - Admin dapat meninjau konfigurasi model AI, mode maintenance, katalog harga/kuota 4 paket (`free`, `starter`, `pro`, `business`), dan status integrasi payment gateway.
  - **Khusus Super Admin**: Dapat mengubah harga bulanan IDR, kuota paket, tema default platform, toggle registrasi baru, dan mode maintenance secara langsung (`PATCH /api/v2/admin/system-settings`).
- **Konfigurasi Payment Gateway (Opsional)**:
  - Secara default, `PaymentProvider` berjalan jujur dalam mode `unconfigured` (tidak ada transaksi palsu; perubahan paket oleh Super Admin dicatat ke `billing_records`).
  - Untuk mengaktifkan gateway pembayaran nyata di server produksi, pasang variabel environment server-side `PAYMENT_PROVIDER` (`midtrans` | `xendit` | `stripe`), `PAYMENT_SERVER_KEY`, `PAYMENT_WEBHOOK_SECRET`, dan `PAYMENT_MODE` (`sandbox` | `live`).
