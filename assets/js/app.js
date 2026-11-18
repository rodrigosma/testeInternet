console.log("Minha Internet Tá Boa? - Versão: v1.10.0 carregada.");

const translations = window.translations;
if (!translations || !translations.pt || !translations.en) {
  throw new Error('Translation files failed to load.');
}

let currentLang = 'pt';

// Configurações de Rede e Estado (Usando um endpoint leve e universal)
const PING_ENDPOINT = 'https://www.cloudflare.com/favicon.ico';
const SPEED_TEST_ENDPOINT = 'https://speed.cloudflare.com';
const SPEED_TEST_PROFILES = {
  light: { downloadBytes: 2000000, uploadBytes: 1000000 },
  detailed: { downloadBytes: 5000000, uploadBytes: 2000000 }
};
const SPEEDOMETER_MAX_MBPS = 100;
const SPEEDOMETER_ARC_LENGTH = 383;
const INTERVAL_MS = 2000;
const TIMEOUT_MS = 3000;
const SPEED_TEST_TIMEOUT_MS = 120000;
const MAX_HISTORY = 30;

let isRunning = true;
let isSpeedTestRunning = false;
let speedTestStatusKey = '';
let timerId = null;
let lastPing = null;
let history = [];
let totalTests = 0;
let failedTests = 0;

function t(key, failed = 0, total = 0) {
  const dict = translations[currentLang] || translations.pt;
  if (key === 'lossSubtitle') {
    return currentLang === 'en' ? `${failed} errors out of ${total} tests` : `${failed} erros de ${total} testes`;
  }
  return dict[key] || translations.pt[key] || key;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.innerHTML = t(key);
  });
  if (speedTestStatusKey) {
    speedTestStatus.innerText = t(speedTestStatusKey);
  }
  toggleBtn.innerText = isRunning ? t('pauseBtn') : t('resumeBtn');
}

const langSelect = document.getElementById('langSelect');
if (langSelect) {
  langSelect.addEventListener('change', (e) => {
    currentLang = e.target.value;
    applyTranslations();
    updateUI(lastPing);
  });
}

// Elementos DOM
const statusIndicator = document.getElementById('statusIndicator');
const statusTitle = document.getElementById('statusTitle');
const statusDescription = document.getElementById('statusDescription');
const toggleBtn = document.getElementById('toggleBtn');
const pingValue = document.getElementById('pingValue');
const pingQuality = document.getElementById('pingQuality');
const jitterValue = document.getElementById('jitterValue');
const jitterQuality = document.getElementById('jitterQuality');
const lossValue = document.getElementById('lossValue');
const lossCount = document.getElementById('lossCount');
const netType = document.getElementById('netType');
const netSpeed = document.getElementById('netSpeed');
const speedTestBtn = document.getElementById('speedTestBtn');
const speedTestProfile = document.getElementById('speedTestProfile');
const speedTestStatus = document.getElementById('speedTestStatus');
const speedTestResults = document.getElementById('speedTestResults');
const speedTestDownloadValue = document.getElementById('speedTestDownloadValue');
const speedTestUploadValue = document.getElementById('speedTestUploadValue');
const speedTestDownloadFeedback = document.getElementById('speedTestDownloadFeedback');
const speedTestUploadFeedback = document.getElementById('speedTestUploadFeedback');
const speedometer = document.getElementById('speedometer');
const speedometerProgress = document.getElementById('speedometerProgress');
const speedometerNeedle = document.getElementById('speedometerNeedle');
const speedometerValue = document.getElementById('speedometerValue');
const speedometerPhase = document.getElementById('speedometerPhase');
const canvas = document.getElementById('latencyChart');
const ctx = canvas.getContext('2d');

// Inicializar Canvas responsivo
function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth - 48;
  canvas.height = 180;
  drawChart();
}
window.addEventListener('resize', resizeCanvas);

// Detecção nativa do navegador (Network Information API) e IP/ISP
let ispLoaded = false;

async function updateNetworkApiInfo() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  
  let typeLabel = t('networkTypeUnknown');
  let speedText = 'Velocidade estimada';

  if (conn) {
    const rawType = conn.type ? conn.type.toLowerCase() : '';

    if (rawType.includes('wifi') || rawType === 'wireless') {
      typeLabel = '📡 Wi-Fi';
    } else if (rawType.includes('ethernet') || rawType === 'ethernet' || rawType === 'wired') {
      typeLabel = '🛜 Cabo (Ethernet)';
    } else if (rawType.includes('cellular') || rawType === 'cellular' || rawType === 'mobile') {
      typeLabel = '📱 Celular';
    }

    if (conn.downlink) {
      speedText = `~${conn.downlink} Mbps | RTT: ${conn.rtt || '--'}ms`;
    } else {
      speedText = conn.effectiveType ? `Tipo: ${conn.effectiveType}` : 'Sem estimativa detalhada';
    }
  } else {
    typeLabel = navigator.onLine ? t('networkTypeUnknown') : '❌ Offline';
    speedText = 'API de rede limitada';
  }

  netType.innerText = typeLabel;

  if (!ispLoaded && navigator.onLine) {
    ispLoaded = true;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        const ispName = data.org || data.asn || 'Provedor desconhecido';
        const cityState = data.city ? `${data.city}/${data.region}` : '';
        netSpeed.innerText = `${ispName} ${cityState ? '(' + cityState + ')' : ''}`;
      } else {
        netSpeed.innerText = speedText;
      }
    } catch (e) {
      netSpeed.innerText = speedText;
    }
  } else if (!navigator.onLine) {
    netSpeed.innerText = 'Sem conexão com a internet';
  }
}

if (navigator.connection) {
  navigator.connection.addEventListener('change', updateNetworkApiInfo);
}
window.addEventListener('online', () => { ispLoaded = false; updateStatus('online'); updateNetworkApiInfo(); });
window.addEventListener('offline', () => updateStatus('offline'));

// Realiza teste de ping
async function measurePing() {
  if (!navigator.onLine) {
    recordResult(null);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startTime = performance.now();

  try {
    // Usando GET simples com no-store para medir RTT real sem bloqueios de CORS
    await fetch(`${PING_ENDPOINT}?t=${Date.now()}`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timeout);
    const duration = Math.round(performance.now() - startTime);
    recordResult(duration);
  } catch (err) {
    clearTimeout(timeout);
    recordResult(null);
  }
}

// Processa os dados
function recordResult(ping) {
  totalTests++;
  const timestamp = new Date();

  if (ping === null) {
    failedTests++;
    history.push({ ping: null, jitter: 0, timestamp });
  } else {
    const jitter = lastPing !== null ? Math.abs(ping - lastPing) : 0;
    lastPing = ping;
    history.push({ ping, jitter, timestamp });
  }

  if (history.length > MAX_HISTORY) {
    history.shift();
  }

  updateUI(ping);
  drawChart();
}

// Atualiza a interface
function updateUI(currentPing) {
  updateNetworkApiInfo();

  // Perda de Pacotes
  const lossRate = ((failedTests / totalTests) * 100).toFixed(1);
  lossValue.innerText = `${lossRate}%`;
  lossCount.innerText = t('lossSubtitle', failedTests, totalTests);

  if (currentPing === null) {
    pingValue.innerHTML = `-- <span class="unit">ms</span>`;
    pingQuality.innerText = t('pingFailed');
    updateStatus('danger', t('statusTimeoutTitle'), t('statusTimeoutDesc'));
    return;
  }

  // Ping
  pingValue.innerHTML = `${currentPing} <span class="unit">ms</span>`;
  if (currentPing < 50) {
    pingQuality.innerText = t('pingQuality1');
    pingQuality.style.color = 'var(--success)';
  } else if (currentPing < 120) {
    pingQuality.innerText = t('pingQuality2');
    pingQuality.style.color = 'var(--accent)';
  } else {
    pingQuality.innerText = t('pingQuality3');
    pingQuality.style.color = 'var(--warning)';
  }

  // Jitter
  const recentValid = history.filter(h => h.ping !== null);
  if (recentValid.length > 1) {
    const currentJitter = recentValid[recentValid.length - 1].jitter;
    jitterValue.innerHTML = `${currentJitter} <span class="unit">ms</span>`;
    if (currentJitter <= 10) {
      jitterQuality.innerText = t('jitterStable');
    } else if (currentJitter <= 30) {
      jitterQuality.innerText = t('jitterModerate');
    } else {
      jitterQuality.innerText = t('jitterUnstable');
    }
  }

  // Status Geral
  if (currentPing < 80 && lossRate < 3) {
    updateStatus('success', t('statusExcelTitle'), t('statusExcelDesc'));
  } else if (currentPing < 150 && lossRate < 8) {
    updateStatus('warning', t('statusAcceptTitle'), t('statusAcceptDesc'));
  } else {
    updateStatus('danger', t('statusInstabTitle'), t('statusInstabDesc'));
  }
}

function updateStatus(state, title, desc) {
  if (state === 'offline' || !navigator.onLine) {
    statusIndicator.style.backgroundColor = 'var(--danger)';
    statusIndicator.style.boxShadow = '0 0 15px var(--danger)';
    statusTitle.innerText = t('statusDisconnectedTitle');
    statusDescription.innerText = t('statusDisconnectedDesc');
    return;
  }

  const colors = {
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)'
  };

  statusIndicator.style.backgroundColor = colors[state] || colors.success;
  statusIndicator.style.boxShadow = `0 0 15px ${colors[state] || colors.success}`;
  if (title) statusTitle.innerText = title;
  if (desc) statusDescription.innerText = desc;
}

// Desenho do Gráfico no Canvas
function drawChart() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (history.length < 2) return;

  const pings = history.map(item => item.ping ?? 250);
  const maxPing = Math.max(100, Math.ceil(Math.max(...pings) * 1.25));

  // Linhas de grade
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    const val = Math.round(maxPing - (maxPing / 4) * i);
    ctx.fillText(`${val}ms`, 8, y - 4);
  }

  // Linha do gráfico
  const step = w / (MAX_HISTORY - 1);
  ctx.beginPath();
  history.forEach((item, index) => {
    const ping = item.ping !== null ? item.ping : maxPing;
    const x = index * step;
    const y = h - (ping / maxPing) * h;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Preenchimento gradiente abaixo da linha
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
  gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

  ctx.lineTo((history.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Pontos nos nós
  history.forEach((item, index) => {
    const ping = item.ping !== null ? item.ping : maxPing;
    const x = index * step;
    const y = h - (ping / maxPing) * h;

    ctx.beginPath();
    ctx.arc(x, y, item.ping === null ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = item.ping === null ? '#ef4444' : '#38bdf8';
    ctx.fill();
  });
}

// Botão Iniciar / Pausar
toggleBtn.addEventListener('click', () => {
  isRunning = !isRunning;
  toggleBtn.innerText = isRunning ? t('pauseBtn') : t('resumeBtn');
  if (isRunning) {
    measurePing();
    timerId = setInterval(measurePing, INTERVAL_MS);
  } else {
    clearInterval(timerId);
  }
});

function calculateMbps(byteCount, elapsedMs) {
  const mbps = (byteCount * 8) / (Math.max(elapsedMs, 1) * 1000);
  const locale = currentLang === 'en' ? 'en-US' : 'pt-BR';
  return `${mbps.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mbps`;
}

function getSpeedFeedbackKey(mbps, direction) {
  if (direction === 'download') {
    if (mbps < 5) return 'speedDownloadLow';
    if (mbps < 25) return 'speedDownloadMedium';
    return 'speedDownloadHigh';
  }

  if (mbps < 1) return 'speedUploadLow';
  if (mbps < 5) return 'speedUploadMedium';
  return 'speedUploadHigh';
}

function setSpeedTestStatus(key) {
  speedTestStatusKey = key;
  speedTestStatus.innerText = t(key);
}

function updateSpeedometer(byteCount, elapsedMs, phaseKey) {
  const mbps = (byteCount * 8) / (Math.max(elapsedMs, 1) * 1000);
  const gaugeRatio = Math.min(mbps / SPEEDOMETER_MAX_MBPS, 1);
  const locale = currentLang === 'en' ? 'en-US' : 'pt-BR';
  speedometerValue.textContent = mbps.toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
  speedometerNeedle.style.transform = `rotate(${-90 + gaugeRatio * 180}deg)`;
  speedometerProgress.style.strokeDashoffset = String(SPEEDOMETER_ARC_LENGTH * (1 - gaugeRatio));
  speedometerPhase.dataset.i18n = phaseKey;
  speedometerPhase.innerText = t(phaseKey);
}

async function readDownloadStream(response, onProgress, startedAt = performance.now()) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = await response.arrayBuffer();
    const elapsedMs = performance.now() - startedAt;
    onProgress(data.byteLength, elapsedMs);
    return { byteCount: data.byteLength, elapsedMs };
  }

  const reader = response.body.getReader();
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    onProgress(byteCount, performance.now() - startedAt);
  }

  return { byteCount, elapsedMs: performance.now() - startedAt };
}

function uploadWithProgress(uploadData, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startedAt = performance.now();
    let lastProgressElapsedMs = 0;
    let lastLoadedBytes = 0;
    let settled = false;

    const cleanup = () => signal.removeEventListener('abort', handleSignalAbort);
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleSignalAbort = () => {
      xhr.abort();
      rejectOnce(new DOMException('The upload test was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', handleSignalAbort, { once: true });
    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      lastLoadedBytes = event.loaded;
      lastProgressElapsedMs = performance.now() - startedAt;
      onProgress(event.loaded, lastProgressElapsedMs);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        rejectOnce(new Error(`Upload test returned HTTP ${xhr.status}`));
        return;
      }
      if (lastLoadedBytes !== uploadData.byteLength) {
        rejectOnce(new Error(`Upload test sent ${lastLoadedBytes} of ${uploadData.byteLength} bytes`));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ elapsedMs: lastProgressElapsedMs || performance.now() - startedAt });
    }, { once: true });
    xhr.addEventListener('error', () => rejectOnce(new Error('Upload test network error.')), { once: true });
    xhr.addEventListener('abort', () => {
      rejectOnce(new DOMException('The upload test was aborted.', 'AbortError'));
    }, { once: true });

    xhr.open('POST', `${SPEED_TEST_ENDPOINT}/__up?t=${Date.now()}`);
    xhr.send(uploadData);
  });
}

async function withSpeedTestTimeout(operation) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SPEED_TEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runSpeedTest() {
  if (isSpeedTestRunning) return;
  if (!navigator.onLine) {
    setSpeedTestStatus('speedTestOffline');
    return;
  }

  isSpeedTestRunning = true;
  speedTestBtn.disabled = true;
  speedTestProfile.disabled = true;
  setSpeedTestStatus('speedTestDownloading');
  speedTestResults.hidden = true;
  speedTestDownloadValue.innerText = '-- Mbps';
  speedTestUploadValue.innerText = '-- Mbps';
  speedTestDownloadFeedback.removeAttribute('data-i18n');
  speedTestUploadFeedback.removeAttribute('data-i18n');
  speedTestDownloadFeedback.innerText = '';
  speedTestUploadFeedback.innerText = '';
  speedometer.hidden = false;
  updateSpeedometer(0, 1, 'speedometerDownloading');

  const wasRunning = isRunning;
  if (wasRunning) {
    isRunning = false;
    clearInterval(timerId);
    timerId = null;
    toggleBtn.innerText = t('resumeBtn');
  }
  toggleBtn.disabled = true;

  let currentPhase = 'download';
  try {
    const profile = SPEED_TEST_PROFILES[speedTestProfile.value];
    const downloadStartedAt = performance.now();
    const downloadResult = await withSpeedTestTimeout(async signal => {
      const response = await fetch(
        `${SPEED_TEST_ENDPOINT}/__down?bytes=${profile.downloadBytes}&t=${Date.now()}`,
        { cache: 'no-store', signal }
      );
      if (!response.ok) {
        throw new Error(`Download test returned HTTP ${response.status}`);
      }
      return readDownloadStream(response, (byteCount, elapsedMs) => {
        updateSpeedometer(byteCount, elapsedMs, 'speedometerDownloading');
      }, downloadStartedAt);
    });
    if (downloadResult.byteCount !== profile.downloadBytes) {
      throw new Error(`Download test returned ${downloadResult.byteCount} of ${profile.downloadBytes} bytes`);
    }
    const downloadMbps = (downloadResult.byteCount * 8) / (Math.max(downloadResult.elapsedMs, 1) * 1000);
    speedTestDownloadValue.innerText = calculateMbps(downloadResult.byteCount, downloadResult.elapsedMs);
    const downloadFeedbackKey = getSpeedFeedbackKey(downloadMbps, 'download');
    speedTestDownloadFeedback.dataset.i18n = downloadFeedbackKey;
    speedTestDownloadFeedback.innerText = t(downloadFeedbackKey);
    speedTestResults.hidden = false;

    currentPhase = 'upload';
    setSpeedTestStatus('speedTestUploading');
    updateSpeedometer(0, 1, 'speedometerUploading');
    const uploadData = new Uint8Array(profile.uploadBytes);
    const uploadResult = await withSpeedTestTimeout(signal => uploadWithProgress(
      uploadData,
      signal,
      (byteCount, elapsedMs) => updateSpeedometer(byteCount, elapsedMs, 'speedometerUploading')
    ));
    const uploadMbps = (uploadData.byteLength * 8) / (Math.max(uploadResult.elapsedMs, 1) * 1000);
    speedTestUploadValue.innerText = calculateMbps(uploadData.byteLength, uploadResult.elapsedMs);
    const uploadFeedbackKey = getSpeedFeedbackKey(uploadMbps, 'upload');
    speedTestUploadFeedback.dataset.i18n = uploadFeedbackKey;
    speedTestUploadFeedback.innerText = t(uploadFeedbackKey);
    speedTestResults.hidden = false;
    setSpeedTestStatus('speedTestDone');
  } catch (error) {
    console.error('Internet speed test failed.', error);
    setSpeedTestStatus(error.name === 'AbortError'
      ? `speedTest${currentPhase === 'download' ? 'Download' : 'Upload'}Timeout`
      : 'speedTestError');
  } finally {
    speedometer.hidden = true;
    isSpeedTestRunning = false;
    speedTestBtn.disabled = false;
    speedTestProfile.disabled = false;
    toggleBtn.disabled = false;
    if (wasRunning) {
      isRunning = true;
      measurePing();
      timerId = setInterval(measurePing, INTERVAL_MS);
    }
    toggleBtn.innerText = isRunning ? t('pauseBtn') : t('resumeBtn');
  }
}

speedTestBtn.addEventListener('click', runSpeedTest);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function downloadFile(content, mimeType, fileName) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getReportData() {
  return {
    ping: document.getElementById('pingValue').innerText.replace(/\s+/g, ' ').trim(),
    jitter: document.getElementById('jitterValue').innerText.replace(/\s+/g, ' ').trim(),
    failures: `${lossValue.innerText} (${lossCount.innerText})`,
    provider: netSpeed.innerText,
    type: netType.innerText,
    status: statusTitle.innerText,
    statusDetails: statusDescription.innerText
  };
}

function getReading(ping) {
  if (ping === null) return t('reportFailed');
  if (ping < 50) return t('reportFast');
  if (ping < 120) return t('reportModerate');
  return t('reportSlow');
}

document.getElementById('reportBtn').addEventListener('click', () => {
  const reportData = getReportData();
  const generatedAt = new Date();
  const locale = currentLang === 'en' ? 'en-US' : 'pt-BR';
  const statusTone = reportData.status === t('statusExcelTitle')
    ? 'good'
    : reportData.status === t('statusAcceptTitle') ? 'warning' : 'bad';
  const historyRows = history.length
    ? history.map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.timestamp.toLocaleString(locale))}</td>
        <td>${item.ping === null ? '—' : item.ping}</td>
        <td>${item.jitter}</td>
        <td>${escapeHtml(getReading(item.ping))}</td>
      </tr>`).join('')
    : `<tr><td class="empty" colspan="5">${escapeHtml(t('reportNoData'))}</td></tr>`;

  const reportHtml = `<!DOCTYPE html>
<html lang="${currentLang === 'en' ? 'en' : 'pt-BR'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(t('reportTitle'))} - ${escapeHtml(generatedAt.toLocaleDateString(locale))}</title>
  <style>
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px; background: #eef2f7; color: #172033; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: auto; overflow: hidden; background: #fff; border: 1px solid #dce3ed; border-radius: 20px; box-shadow: 0 16px 40px rgba(15, 23, 42, .12); }
header { padding: 32px; color: #fff; background: linear-gradient(135deg, #0f172a, #0369a1); }
header p { margin: 0; color: #dbeafe; }
header h1 { margin: 4px 0 8px; font-size: clamp(1.7rem, 5vw, 2.3rem); }
.content { padding: 28px 32px 32px; }
.meta, .note, .tip { color: #526176; font-size: .9rem; }
.summary { margin: 22px 0; padding: 20px; border: 1px solid; border-radius: 14px; }
.summary h2, section h2 { margin: 0 0 12px; font-size: 1.15rem; }
.summary p { margin: 6px 0 0; }
.good { color: #065f46; background: #ecfdf5; border-color: #a7f3d0; }
.warning { color: #92400e; background: #fffbeb; border-color: #fde68a; }
.bad { color: #991b1b; background: #fef2f2; border-color: #fecaca; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0 28px; }
.metric { padding: 16px; border: 1px solid #dce3ed; border-radius: 12px; background: #f8fafc; }
.metric span { display: block; color: #526176; font-size: .82rem; }
.metric strong { display: block; margin-top: 5px; font-size: 1.2rem; overflow-wrap: anywhere; }
section { margin-top: 24px; }
.table-wrap { overflow-x: auto; border: 1px solid #dce3ed; border-radius: 12px; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid #e5eaf1; white-space: nowrap; }
th { color: #334155; background: #f1f5f9; font-size: .8rem; }
tbody tr:last-child td { border-bottom: 0; }
.empty { color: #64748b; text-align: center; white-space: normal; }
.note { margin-top: 22px; padding: 14px 16px; border-left: 4px solid #0284c7; background: #f0f9ff; border-radius: 6px; }
.tip { margin-top: 18px; text-align: center; }
@media (max-width: 600px) { body { padding: 12px; } header, .content { padding: 22px 18px; } }
@media print { body { padding: 0; background: #fff; } main { border: 0; border-radius: 0; box-shadow: none; } header { print-color-adjust: exact; -webkit-print-color-adjust: exact; } .summary, .metric, th, .note { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  </style>
</head>
<body>
  <main>
<header>
  <p>${escapeHtml(t('reportGenerated'))}: ${escapeHtml(generatedAt.toLocaleString(locale))}</p>
  <h1>${escapeHtml(t('reportTitle'))}</h1>
  <p>${escapeHtml(t('reportIntro'))}</p>
</header>
<div class="content">
  <section class="summary ${statusTone}">
    <h2>${escapeHtml(t('reportSummary'))}: ${escapeHtml(reportData.status)}</h2>
    <p>${escapeHtml(reportData.statusDetails)}</p>
  </section>
  <section>
    <h2>${escapeHtml(t('reportMetrics'))}</h2>
    <div class="metrics">
      <div class="metric"><span>${escapeHtml(t('reportPing'))}</span><strong>${escapeHtml(reportData.ping)}</strong></div>
      <div class="metric"><span>${escapeHtml(t('reportJitter'))}</span><strong>${escapeHtml(reportData.jitter)}</strong></div>
      <div class="metric"><span>${escapeHtml(t('reportFailures'))}</span><strong>${escapeHtml(reportData.failures)}</strong></div>
      <div class="metric"><span>${escapeHtml(t('reportNetworkType'))}</span><strong>${escapeHtml(reportData.type)}</strong></div>
      <div class="metric"><span>${escapeHtml(t('reportProvider'))}</span><strong>${escapeHtml(reportData.provider)}</strong></div>
    </div>
  </section>
  <section>
    <h2>${escapeHtml(t('reportHistory'))}</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>${escapeHtml(t('reportNumber'))}</th>
          <th>${escapeHtml(t('reportDateTime'))}</th>
          <th>${escapeHtml(t('reportResponse'))}</th>
          <th>${escapeHtml(t('reportVariation'))}</th>
          <th>${escapeHtml(t('reportReading'))}</th>
        </tr></thead>
        <tbody>${historyRows}</tbody>
      </table>
    </div>
  </section>
  <p class="note">${escapeHtml(t('reportLimitNote'))}</p>
  <p class="tip">${escapeHtml(t('reportPrintTip'))}</p>
</div>
  </main>
</body>
</html>`;

  const printFrame = document.createElement('iframe');
  printFrame.title = t('reportTitle');
  printFrame.setAttribute('aria-hidden', 'true');
  printFrame.style.cssText = 'position:fixed;left:-10000px;top:0;width:100vw;height:100vh;border:0;';
  printFrame.addEventListener('load', () => {
    const printWindow = printFrame.contentWindow;
    if (!printWindow || typeof printWindow.print !== 'function') {
      printFrame.remove();
      alert(t('reportPrintError'));
      return;
    }

    printWindow.addEventListener('afterprint', () => printFrame.remove(), { once: true });
    printWindow.focus();
    try {
      printWindow.print();
    } catch (error) {
      printFrame.remove();
      alert(t('reportPrintError'));
      console.error('Unable to open the report print dialog.', error);
    }
  }, { once: true });
  printFrame.srcdoc = reportHtml;
  document.body.appendChild(printFrame);
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const reportData = getReportData();
  const generatedAt = new Date();
  const locale = currentLang === 'en' ? 'en-US' : 'pt-BR';
  const csvEscape = value => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [
    [t('reportTitle')],
    [],
    [t('reportGenerated'), generatedAt.toLocaleString(locale)],
    [],
    [t('reportSummary')],
    [t('reportStatus'), reportData.status],
    [t('reportStatusDetails'), reportData.statusDetails],
    [],
    [t('reportMetrics')],
    [t('reportPing'), reportData.ping],
    [t('reportJitter'), reportData.jitter],
    [t('reportFailures'), reportData.failures],
    [t('reportNetworkType'), reportData.type],
    [t('reportProvider'), reportData.provider],
    [],
    [t('reportHistory')],
    [t('reportNumber'), t('reportDateTime'), t('reportResponse'), t('reportVariation'), t('reportReading')],
    ...history.map((item, index) => [
      index + 1,
      item.timestamp.toLocaleString(locale),
      item.ping === null ? t('reportFailed') : item.ping,
      item.jitter,
      getReading(item.ping)
    ])
  ];
  const csvContent = '\ufeff' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  downloadFile(csvContent, 'text/csv;charset=utf-8;', `relatorio_internet_${generatedAt.getTime()}.csv`);
});

// Função para reiniciar / limpar o estado se necessário
// Iniciar
resizeCanvas();
updateNetworkApiInfo();
measurePing();
timerId = setInterval(measurePing, INTERVAL_MS);
