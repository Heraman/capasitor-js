// =====================================================
//  Bunkr DL — Capacitor App
//  Port dari bunkr-dl.js ke Vanilla JS + Capacitor
// =====================================================

import { CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

// --- KONSTANTA ---
const BUNKR_VS_API_URL = "https://bunkr.cr/api/vs";
const SECRET_KEY_BASE  = "SECRET_KEY_";
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Referer':    'https://bunkr.sk/',
};

// --- DOM REFS ---
const urlInput       = document.getElementById('urlInput');
const downloadBtn    = document.getElementById('downloadBtn');
const btnText        = document.getElementById('btnText');
const btnSpinner     = document.getElementById('btnSpinner');
const pasteBtn       = document.getElementById('pasteBtn');
const progressSection= document.getElementById('progressSection');
const progressLabel  = document.getElementById('progressLabel');
const progressCount  = document.getElementById('progressCount');
const progressBar    = document.getElementById('progressBar');
const currentFile    = document.getElementById('currentFile');
const logSection     = document.getElementById('logSection');
const logContainer   = document.getElementById('logContainer');
const clearLogBtn    = document.getElementById('clearLogBtn');
const resultSection  = document.getElementById('resultSection');
const resultContent  = document.getElementById('resultContent');

// --- UI HELPERS ---

function setLoading(on) {
  downloadBtn.disabled = on;
  btnText.textContent  = on ? 'Mendownload...' : 'Mulai Download';
  btnSpinner.classList.toggle('hidden', !on);
}

function showProgress(show) {
  progressSection.classList.toggle('hidden', !show);
}

function updateProgress(current, total, filename) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width    = pct + '%';
  progressCount.textContent  = `${current}/${total}`;
  progressLabel.textContent  = `Mengunduh... ${pct}%`;
  currentFile.textContent    = filename ? `📄 ${filename}` : '';
}

function addLog(type, message) {
  // type: 'ok' | 'skip' | 'fail' | 'info'
  logSection.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const icons = { ok: '✓', skip: '⊘', fail: '✗', info: '•' };
  line.textContent = `${icons[type] ?? '•'} ${message}`;
  logContainer.appendChild(line);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function showResult({ albumName, success, fail, skipped }) {
  resultSection.classList.remove('hidden');
  const total = success + fail + skipped;
  resultContent.innerHTML = `
    <div class="result-box">
      <div class="result-icon">${fail === 0 ? '🎉' : '⚠️'}</div>
      <div>
        <div class="result-title">${fail === 0 ? 'Selesai!' : 'Selesai dengan error'}</div>
        <div class="result-sub">${albumName || 'Download selesai'} — ${total} file</div>
      </div>
    </div>
    <div class="result-stats">
      <div class="stat">
        <div class="stat-num green">${success}</div>
        <div class="stat-label">Berhasil</div>
      </div>
      <div class="stat">
        <div class="stat-num yellow">${skipped}</div>
        <div class="stat-label">Dilewati</div>
      </div>
      <div class="stat">
        <div class="stat-num red">${fail}</div>
        <div class="stat-label">Gagal</div>
      </div>
    </div>
  `;
}

// --- CORE LOGIC (port dari bunkr-dl.js) ---

/**
 * Dekripsi URL dari response API bunkr
 * Sama persis dengan fungsi decryptUrl di bunkr-dl.js
 */
function decryptUrl(encryptedUrl, timestamp) {
  const secretKey      = `${SECRET_KEY_BASE}${Math.floor(timestamp / 3600)}`;
  const encryptedBytes = Uint8Array.from(atob(encryptedUrl), c => c.charCodeAt(0));
  const keyBytes       = new TextEncoder().encode(secretKey);
  let decrypted        = '';
  for (let i = 0; i < encryptedBytes.length; i++) {
    decrypted += String.fromCharCode(encryptedBytes[i] ^ keyBytes[i % keyBytes.length]);
  }
  return decrypted.replace(/\0/g, '').trim();
}

/**
 * Ambil direct download link dari URL item bunkr
 * Menggunakan CapacitorHttp agar tidak kena CORS
 */
async function getDownloadLink(itemUrl) {
  try {
    const match = itemUrl.match(/\/([vfi])\/(.*?)$/);
    if (!match || !match[2]) return null;
    const slug = match[2].split('?')[0];

    const response = await CapacitorHttp.post({
      url:     BUNKR_VS_API_URL,
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      data:    JSON.stringify({ slug }),
    });

    const data = response.data;
    if (!data?.url || !data?.timestamp) return null;
    return decryptUrl(data.url, data.timestamp);
  } catch (e) {
    console.error('getDownloadLink error:', e);
    return null;
  }
}

/**
 * Ambil daftar URL item dari halaman album
 * Parse HTML menggunakan DOMParser (tersedia di WebView)
 */
async function getAlbumItems(albumUrl) {
  const response = await CapacitorHttp.get({
    url:     albumUrl,
    headers: HEADERS,
  });

  const parser = new DOMParser();
  const doc    = parser.parseFromString(response.data, 'text/html');

  // Ambil nama album
  const albumName = (doc.querySelector('h1')?.textContent?.trim() || 'Album_Bunkr')
    .replace(/[\\/:*?"<>|]/g, '_');

  // Ambil semua link item (selector sama dengan versi Node.js)
  const host  = new URL(albumUrl).origin;
  const links = [];
  doc.querySelectorAll('a').forEach(el => {
    const href = el.getAttribute('href');
    // Filter hanya link /v/ /f/ /i/ (item bunkr)
    if (href && /^\/(v|f|i)\//.test(href)) {
      links.push(host + href);
    }
  });

  // Fallback: coba selector berbeda jika links kosong
  if (links.length === 0) {
    doc.querySelectorAll('[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (href && /bunkr\.(sk|cr|si|is|fi|ph|ru|media)\/(v|f|i)\//.test(href)) {
        links.push(href.startsWith('http') ? href : host + href);
      }
    });
  }

  return { albumName, links };
}

/**
 * Download satu file dan simpan ke Filesystem HP
 * Menggunakan CapacitorHttp + Filesystem plugin
 */
async function downloadFile(directUrl, filename, folderName) {
  // Cek apakah file sudah ada
  try {
    await Filesystem.stat({
      path:      `Downloads/BunkrDL/${folderName}/${filename}`,
      directory: Directory.External,
    });
    addLog('skip', `${filename} (sudah ada)`);
    return 'skip';
  } catch {
    // File belum ada, lanjut download
  }

  // Download file sebagai base64
  const strategies = [
    { ...HEADERS },
    { ...HEADERS, Referer: directUrl },
  ];

  for (const headers of strategies) {
    try {
      const response = await CapacitorHttp.get({
        url:          directUrl,
        headers,
        responseType: 'blob', // ⬅ Capacitor HTTP blob response
      });

      // Simpan ke storage HP
      await Filesystem.writeFile({
        path:      `Downloads/BunkrDL/${folderName}/${filename}`,
        data:      response.data,  // base64 string dari blob
        directory: Directory.External,
        recursive: true,
      });

      addLog('ok', filename);
      return 'ok';
    } catch (e) {
      console.error('downloadFile error:', e);
    }
  }

  addLog('fail', `${filename} — gagal download`);
  return 'fail';
}

// --- MAIN HANDLER ---

async function startDownload() {
  const url = urlInput.value.trim();
  if (!url) {
    alert('Masukkan URL Bunkr terlebih dahulu!');
    return;
  }
  if (!url.startsWith('http')) {
    alert('URL tidak valid. Harus diawali dengan https://');
    return;
  }

  // Reset UI
  logContainer.innerHTML   = '';
  resultContent.innerHTML  = '';
  resultSection.classList.add('hidden');
  logSection.classList.add('hidden');

  setLoading(true);
  showProgress(true);
  progressLabel.textContent = 'Mengambil info...';

  const urlPath = url.replace(/\/$/, '');
  const urlType = urlPath.split('/').at(-2); // 'a', 'v', 'f', 'i'

  try {
    if (urlType === 'a') {
      // ========== MODE ALBUM ==========
      addLog('info', `Mengambil daftar item dari album...`);
      progressLabel.textContent = 'Mengambil daftar item...';

      const { albumName, links } = await getAlbumItems(url);

      if (links.length === 0) {
        addLog('fail', 'Tidak ada item ditemukan di album ini.');
        showResult({ albumName, success: 0, fail: 0, skipped: 0 });
        return;
      }

      addLog('info', `Album: "${albumName}" — ${links.length} item`);
      addLog('info', `Menyimpan ke: Downloads/BunkrDL/${albumName}`);

      let success = 0, fail = 0, skipped = 0;

      for (let i = 0; i < links.length; i++) {
        const itemUrl = links[i];
        updateProgress(i, links.length, `Item ${i + 1}...`);
        addLog('info', `[${i + 1}/${links.length}] Mengambil link...`);

        const directLink = await getDownloadLink(itemUrl);
        if (!directLink) {
          addLog('fail', `Item ${i + 1} — tidak bisa ambil link`);
          fail++;
          continue;
        }

        const filename = new URL(directLink).pathname.split('/').pop();
        updateProgress(i + 1, links.length, filename);

        const result = await downloadFile(directLink, filename, albumName);
        if (result === 'ok')   success++;
        else if (result === 'skip') skipped++;
        else fail++;
      }

      updateProgress(links.length, links.length, '');
      progressLabel.textContent = 'Selesai!';
      showResult({ albumName, success, fail, skipped });

    } else {
      // ========== MODE SINGLE FILE ==========
      addLog('info', `Single file: ${url}`);
      progressLabel.textContent = 'Mengambil link download...';
      updateProgress(0, 1, '');

      const directLink = await getDownloadLink(url);
      if (!directLink) {
        addLog('fail', 'Tidak bisa mendapatkan link download.');
        showResult({ albumName: 'Single File', success: 0, fail: 1, skipped: 0 });
        return;
      }

      const filename = new URL(directLink).pathname.split('/').pop();
      updateProgress(1, 1, filename);

      const result = await downloadFile(directLink, filename, 'Others');
      showResult({
        albumName: 'Single File',
        success:  result === 'ok'   ? 1 : 0,
        fail:     result === 'fail' ? 1 : 0,
        skipped:  result === 'skip' ? 1 : 0,
      });
    }

  } catch (e) {
    addLog('fail', `Error: ${e.message}`);
    console.error(e);
  } finally {
    setLoading(false);
  }
}

// --- EVENT LISTENERS ---

downloadBtn.addEventListener('click', startDownload);

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) urlInput.value = text;
  } catch {
    // Clipboard API mungkin butuh izin di beberapa device
    alert('Paste manual: tekan lama di kotak input lalu pilih Paste');
  }
});

clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = '';
  logSection.classList.add('hidden');
});

// Submit dengan Enter
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') startDownload();
});