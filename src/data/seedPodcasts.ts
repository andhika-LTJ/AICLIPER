import type { StudioStoreState } from '../types/clipper.ts';
import { resolveAssetUrl } from '../utils/assetUrl.ts';

export const SAMPLE_PODCAST_PRESETS = [
  {
    label: 'Podcast Teknologi & AI (3Blue1Brown)',
    url: 'https://www.youtube.com/watch?v=aircAruvnKk',
  },
  {
    label: 'Inside the Mind of a Master Procrastinator',
    url: 'https://www.youtube.com/watch?v=arj7oStGLkU',
  },
  {
    label: 'How Great Leaders Inspire Action',
    url: 'https://www.youtube.com/watch?v=qp0HIF3SfI4',
  },
];

export const INITIAL_STUDIO_STATE: StudioStoreState = {
  episodes: [
    {
      id: 'ep-seed-1',
      videoId: 'aircAruvnKk',
      sourceUrl: 'https://www.youtube.com/watch?v=aircAruvnKk',
      title: 'Strategi Konten Podcast: Mengubah Diskusi 90 Menit Menjadi Klip Shorts Berdampak',
      channelName: 'Ruang Bicara Studio',
      thumbnailUrl: resolveAssetUrl('/src/assets/images/podcast_studio_tech_1794847026161.jpg'),
      fallbackImageUrl: resolveAssetUrl('/src/assets/images/podcast_studio_tech_1794847026161.jpg'),
      durationSec: 2840,
      transcriptSource: 'curated_sample',
      episodeSummary:
        'Episode ini membahas bagaimana podcaster dan tim produksi memetakan struktur percakapan berdurasi panjang menjadi potongan video vertikal 30–50 detik yang kuat di tiga detik pertama, sekaligus mendistribusikan ringkasan teksnya ke YouTube Shorts, TikTok, Reels, X, dan LinkedIn.',
      keyTopics: [
        'Struktur hook 3 detik pertama untuk retensi Shorts',
        'Teknik memilih argumen kontras dalam wawancara podcast',
        'Otomatisasi subtitle dinamis dan ringkasan lintas platform',
      ],
      chapters: [
        { timeSec: 0, title: 'Pembukaan & Masalah Klip Podcast Sepi' },
        { timeSec: 412, title: 'Aturan 3 Detik Pertama di Shorts & Reels' },
        { timeSec: 1180, title: 'Workflow 1 Episode Jadi 5 Konten Lintas Kanal' },
        { timeSec: 1945, title: 'Kapan Auto-Post vs Kurasi Manual' },
      ],
      keyQuotes: [
        'Penonton Shorts tidak menunggu konteks lima belas detik; mereka memutuskan bertahan atau geser dalam tiga detik pertama.',
        'Satu episode berdurasi satu jam punya minimal empat argumen yang berdiri sendiri.',
      ],
      createdAt: '2026-11-16T07:30:00.000Z',
    },
  ],
  clips: [
    {
      id: 'clip-seed-1',
      episodeId: 'ep-seed-1',
      orderIndex: 1,
      title: 'Aturan 3 Detik: Kenapa Pembukaan Podcast Sering Gagal di Shorts',
      hookLine: 'Jangan mulai klip podcast dengan sapaan pembuka — mulai langsung dari pernyataan paling tajam.',
      startSec: 412,
      endSec: 458,
      ringkasanTeks:
        'Mayoritas klip podcast kehilangan 65% penonton di tiga detik awal karena masih membawa sapaan "halo semuanya". Memotong langsung ke kalimat konflik atau angka mengejutkan membuat algoritma Shorts mendorong distribusi lebih luas.',
      poinKunci: [
        'Buang basa-basi intro dan langsung masuk ke premis inti',
        'Gunakan subtitle kata-per-frasa di area aman tengah layar 9:16',
        'Jaga durasi optimal antara 35 hingga 50 detik untuk loop tonton ulang',
      ],
      transcriptExcerpt:
        'Kesalahan terbesar tim clipping adalah memotong dari awal topik, bukan dari puncak ketegangannya. Penonton Shorts tidak menunggu konteks lima belas detik; mereka memutuskan bertahan atau geser dalam tiga detik pertama.',
      captionCues: [
        { offsetSec: 0, durationSec: 4.5, text: 'Kesalahan terbesar tim clipping adalah memotong dari awal topik,' },
        { offsetSec: 4.5, durationSec: 4.5, text: 'bukan langsung dari puncak ketegangannya.' },
        { offsetSec: 9, durationSec: 5, text: 'Penonton Shorts memutuskan bertahan atau geser' },
        { offsetSec: 14, durationSec: 4, text: 'hanya dalam tiga detik pertama.' },
      ],
      priorityLabel: 'Sorotan Utama',
      viralScore: 92,
      viralReason: 'Hook pembuka langsung menantang kebiasaan editor podcast dengan angka retensi yang konkret.',
      qualityScores: {
        hookStrength: 95,
        emotionalImpact: 82,
        informationValue: 94,
        entertainmentValue: 84,
        contextCompleteness: 92,
        engagementPotential: 91,
        shareabilityPotential: 93,
        overallScore: 91,
        momentType: 'edukatif',
      },
      status: 'draft',
      publishedPlatforms: [],
      platformCopies: {
        youtube_shorts: {
          title: 'Jangan Mulai Klip Podcast Seperti Ini! #Shorts',
          caption:
            'Ringkasan klip: Kenapa 3 detik pertama menentukan performa YouTube Shorts dari podcast panjang. Simpan untuk referensi produksi kontenmu.',
          hashtags: ['#Shorts', '#PodcastIndonesia', '#TipsKonten'],
        },
        tiktok: {
          title: 'Aturan 3 Detik Klip Podcast',
          caption:
            'Banyak editor masih potong dari intro sapaan. Coba mulai langsung dari kalimat paling kontras di menit tengah.',
          hashtags: ['#podcastclips', '#contentcreator', '#editingtips'],
        },
        instagram_reels: {
          title: 'Framework Potong Podcast Jadi Reels',
          caption:
            'Tiga detik pertama menentukan retensi. Cek ringkasan poin kuncinya dan terapkan di episode berikutnya.',
          hashtags: ['#reelsindonesia', '#podcast', '#strategikonten'],
        },
        facebook_reels: {
          title: 'Kenapa Klip Podcast Sering Gagal di 3 Detik Awal?',
          caption:
            'Jangan mulai klip dari basa-basi pembuka. Langsung masuk ke pernyataan paling tajam agar penonton betah sampai akhir.',
          hashtags: ['#FacebookReels', '#PodcastIndonesia', '#TipsKreator'],
        },
        x_twitter: {
          title: 'Pelajaran cepat soal retensi klip podcast',
          caption:
            'Penonton video pendek tidak menunggu konteks 15 detik. Mulai potongan tepat di kalimat tesis atau pertanyaan paling tajam.',
          hashtags: ['#Podcast', '#CreatorEconomy'],
        },
        linkedin: {
          title: 'Mengoptimalkan Distribusi Podcast B2B lewat Klip Vertikal',
          caption:
            'Mengubah satu episode podcast berdurasi 45 menit menjadi 4 klip terfokus dapat memperluas jangkauan organik di YouTube Shorts dan media sosial profesional.',
          hashtags: ['#ContentMarketing', '#PodcastStrategy', '#VideoMarketing'],
        },
      },
    },
    {
      id: 'clip-seed-2',
      episodeId: 'ep-seed-1',
      orderIndex: 2,
      title: 'Workflow 1 Episode Podcast Jadi 5 Konten Lintas Platform',
      hookLine: 'Satu percakapan mendalam seharusnya cukup menghidupi kalender konten selama seminggu penuh.',
      startSec: 1180,
      endSec: 1222,
      ringkasanTeks:
        'Alih-alih memproduksi konten terpisah untuk setiap media sosial, satu rekaman podcast dapat dipecah menjadi video vertikal untuk Shorts/Reels/TikTok dan ringkasan teks terstruktur untuk X serta LinkedIn.',
      poinKunci: [
        'Tandai momen dengan perubahan intonasi atau tawa spontan',
        'Sesuaikan gaya caption: lugas di X, naratif di LinkedIn, hook cepat di Shorts',
      ],
      transcriptExcerpt:
        'Satu episode berdurasi satu jam punya minimal empat argumen yang berdiri sendiri. Ketika dipotong lengkap dengan ringkasan teksnya, distribusi ke lima platform bisa berjalan otomatis dalam hitungan menit.',
      captionCues: [
        { offsetSec: 0, durationSec: 4.5, text: 'Satu episode berdurasi satu jam punya minimal empat argumen,' },
        { offsetSec: 4.5, durationSec: 4.5, text: 'yang bisa berdiri sendiri sebagai klip pendek.' },
        { offsetSec: 9, durationSec: 5, text: 'Dengan ringkasan teks otomatis, distribusi ke lima platform' },
        { offsetSec: 14, durationSec: 4, text: 'bisa selesai dalam hitungan menit.' },
      ],
      priorityLabel: 'Sorotan Utama',
      viralScore: 88,
      viralReason: 'Memberikan blueprint praktis yang mudah disimpan dan dibagikan oleh tim konten & kreator.',
      qualityScores: {
        hookStrength: 87,
        emotionalImpact: 78,
        informationValue: 93,
        entertainmentValue: 80,
        contextCompleteness: 90,
        engagementPotential: 86,
        shareabilityPotential: 92,
        overallScore: 87,
        momentType: 'informatif',
      },
      status: 'published_manual',
      publishedPlatforms: ['youtube_shorts', 'x_twitter'],
      lastPublishedAt: '2026-11-16T07:45:00.000Z',
      platformCopies: {
        youtube_shorts: {
          title: '1 Podcast = 5 Konten Sosmed Otomatis #Shorts',
          caption:
            'Cara memecah satu rekaman podcast menjadi beberapa YouTube Shorts dan utas ringkasan tanpa mengulang rekaman.',
          hashtags: ['#Shorts', '#WorkflowKreator', '#Podcast'],
        },
        tiktok: {
          title: 'Workflow Konten 1 Jam Jadi Seminggu',
          caption: 'Rekam sekali, potong momen terbaiknya, lalu sebar ke semua kanal.',
          hashtags: ['#workflow', '#kreatorindonesia', '#podcast'],
        },
        instagram_reels: {
          title: 'Sistem Repurpose Podcast',
          caption: 'Berhenti bikin konten dari nol setiap hari. Maksimalkan arsip podcastmu.',
          hashtags: ['#repurposecontent', '#reels', '#kreator'],
        },
        facebook_reels: {
          title: 'Satu Episode Podcast Jadi Stok Konten Seminggu',
          caption: 'Pecah satu obrolan panjang menjadi video vertikal dan ringkasan siap unggah.',
          hashtags: ['#FacebookReels', '#ContentWorkflow', '#Podcast'],
        },
        x_twitter: {
          title: '1 podcast 60 menit = 4 klip + 1 ringkasan teks',
          caption:
            'Kunci konsistensi bukan merekam lebih sering, tapi sistem kliping dan distribusi lintas platform yang rapi.',
          hashtags: ['#ContentOps', '#Podcast'],
        },
        linkedin: {
          title: 'Efisiensi Produksi Konten Tim Media dengan Kliping Otomatis',
          caption:
            'Dengan mengekstrak momen inti dan ringkasan teks secara sistematis, satu sesi wawancara eksekutif mampu mengisi seluruh kanal distribusi mingguan.',
          hashtags: ['#MediaProduction', '#B2BMarketing'],
        },
      },
    },
    {
      id: 'clip-seed-3',
      episodeId: 'ep-seed-1',
      orderIndex: 3,
      title: 'Kapan Harus Auto-Post dan Kapan Perlu Kurasi Manual',
      hookLine: 'Otomatisasi mempercepat volume, tapi kurasi manual menjaga kualitas judul dan konteks sensitif.',
      startSec: 1945,
      endSec: 1983,
      ringkasanTeks:
        'Sistem bot clipper paling efektif menggabungkan pemotongan otomatis dengan opsi tinjauan cepat sebelum publikasi ke YouTube Shorts untuk topik teknis atau opini yang membutuhkan konteks akurat.',
      poinKunci: [
        'Gunakan Auto-Post untuk klip tips ringan dan kutipan inspiratif',
        'Pilih Manual Review untuk topik sensitif atau butuh penyesuaian frame trim',
      ],
      transcriptExcerpt:
        'Bot tidak seharusnya menggantikan selera editorial sepenuhnya. Biarkan sistem menemukan timestamp terbaik dan menyusun ringkasannya, lalu kreator memilih: langsung auto-post atau tinjau manual 30 detik sebelum naik ke Shorts.',
      captionCues: [
        { offsetSec: 0, durationSec: 4.5, text: 'Biarkan bot menemukan timestamp terbaik dan menyusun ringkasannya,' },
        { offsetSec: 4.5, durationSec: 4.5, text: 'lalu kreator cukup memilih antara langsung auto-post' },
        { offsetSec: 9, durationSec: 4, text: 'atau tinjau manual 30 detik sebelum naik ke Shorts.' },
      ],
      priorityLabel: 'Klip Pendukung',
      viralScore: 84,
      viralReason: 'Menjawab dilema nyata kreator soal otomasi vs kontrol editorial dengan sudut pandang seimbang.',
      qualityScores: {
        hookStrength: 83,
        emotionalImpact: 76,
        informationValue: 88,
        entertainmentValue: 78,
        contextCompleteness: 89,
        engagementPotential: 85,
        shareabilityPotential: 84,
        overallScore: 84,
        momentType: 'edukatif',
      },
      status: 'draft',
      publishedPlatforms: [],
      platformCopies: {
        youtube_shorts: {
          title: 'Auto-Post vs Manual Review YouTube Shorts #Shorts',
          caption:
            'Kapan waktu terbaik memakai publikasi otomatis dan kapan sebaiknya tinjau manual sebelum unggah ke Shorts.',
          hashtags: ['#Shorts', '#YouTubeShorts', '#Automation'],
        },
        tiktok: {
          title: 'Auto-Post atau Manual Review?',
          caption: 'Kombinasi AI clipper + sentuhan editorial tetap paling aman.',
          hashtags: ['#aicreator', '#podcastclips', '#tiktoktips'],
        },
        instagram_reels: {
          title: 'Menjaga Kualitas Klip Otomatis',
          caption: 'Kecepatan otomatisasi bertemu kontrol editorial.',
          hashtags: ['#instagramreels', '#editorial', '#podcast'],
        },
        facebook_reels: {
          title: 'Auto-Post atau Tinjau Manual Sebelum Unggah?',
          caption: 'Gunakan AI untuk kecepatan, tapi tetap pegang kendali editorial untuk topik penting.',
          hashtags: ['#FacebookReels', '#Editorial', '#AIWorkflow'],
        },
        x_twitter: {
          title: 'Otomatisasi + Kurasi Manual',
          caption:
            'Biarkan bot potong dan ringkas, manusia pegang kendali akhir sebelum tayang ke YouTube Shorts.',
          hashtags: ['#AIWorkflow', '#YouTubeShorts'],
        },
        linkedin: {
          title: 'Human-in-the-Loop dalam Otomatisasi Distribusi Video',
          caption:
            'Menyeimbangkan kecepatan publikasi otomatis dan akurasi pesan merek pada kanal video pendek.',
          hashtags: ['#DigitalStrategy', '#Automation'],
        },
      },
    },
  ],
  distributionLogs: [
    {
      id: 'log-seed-1',
      clipId: 'clip-seed-2',
      clipTitle: 'Workflow 1 Episode Podcast Jadi 5 Konten Lintas Platform',
      episodeTitle: 'Strategi Konten Podcast: Mengubah Diskusi 90 Menit Menjadi Klip Shorts Berdampak',
      mode: 'manual',
      platforms: ['youtube_shorts', 'x_twitter'],
      webhookDelivered: false,
      status: 'success',
      message: 'Paket Shorts (.srt & metadata) diekspor untuk unggah manual dan dibagikan ke X.',
      timestamp: '2026-11-16T07:45:00.000Z',
    },
  ],
  automation: {
    autoPostOnAnalyze: false,
    defaultPlatforms: ['youtube_shorts', 'tiktok', 'instagram_reels', 'x_twitter', 'linkedin'],
    minClipSec: 45,
    maxClipSec: 90,
    targetClipCount: 3,
    youtubeDefaultVisibility: 'public',
    webhookUrl: '',
    webhookSecretHeader: '',
    autoAddHashtagShorts: true,
    enableUltraHdRender: false,
    defaultRenderQuality: '1080p',
    defaultRenderLayout: 'shorts_full_bleed',
    enableAiEmotionEffects: true,
    enableAiIntro: true,
  },
};
