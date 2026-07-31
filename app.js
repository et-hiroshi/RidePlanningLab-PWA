import {RUNTIME_VERSION, estimateDestination, estimateDistance, validateArtifact} from './runtime/ride_planning_runtime.js';
import {APP_VERSION, CALCULATION_CONTRACT_VERSION, appendExecutionSnapshot, createExecutionSnapshot, deleteAllExecutionSnapshots, deleteExecutionSnapshot, executionSnapshotsFilename, executionSnapshotsJsonl, loadExecutionSnapshots, sameExecutionSnapshotContent} from './execution_snapshots.js?v=ride-planning-ui-v15';

const presets = [
  ['collection', 'カード収集', 10, true],
  ['lunch', '昼食', 40, true],
  ['snack', '軽食', 20, false],
  ['sightseeing', '観光・見学', 30, false],
  ['other', 'その他', 10, false],
];

let artifactProvider = () => undefined;
let initialized = false;

function eventRows() {
  return presets.map(([code, label, minutes, checked]) => `
    <div class="event">
      <label><input type="checkbox" name="selected_event" value="${code}"${checked ? ' checked' : ''}><span>${label}</span></label>
      <label class="minutes"><input type="number" name="event_${code}" value="${minutes}" min="0" step="1" inputmode="numeric"><span>分</span></label>
    </div>`).join('');
}

function selectedEvents(form) {
  const data = new FormData(form);
  return [...form.querySelectorAll('[name=selected_event]:checked')].map((box, routeOrder) => {
    const minutes = Number(data.get(`event_${box.value}`));
    if (!Number.isInteger(minutes) || minutes < 0) {
      throw new Error('予定イベント時間は0以上の整数で入力してください。');
    }
    return {
      event_code: box.value,
      route_order: routeOrder,
      planned_duration_sec: minutes * 60,
      minutes,
    };
  });
}

function unexpectedMinutes(form) {
  if (!form.elements.unexpected_enabled.checked) return 0;
  const value = Number(form.elements.unexpected_buffer_minutes.value);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('バッファ時間は0以上の整数で入力してください。');
  }
  return value;
}

function updateSubmitState(form) {
  const button = form.querySelector('button.primary');
  if (!button) return;
  const enabled = artifactProvider() !== undefined && form.checkValidity();
  button.disabled = !enabled;
  if (enabled) button.removeAttribute('disabled');
  else button.setAttribute('disabled', '');
}

function updateAllSubmitStates() {
  if (!initialized) return;
  document.querySelectorAll('form').forEach(updateSubmitState);
}

function initializeSubmitStates() {
  if (initialized) return;
  const forms = [...document.querySelectorAll('form')];
  if (!forms.length) return;
  initialized = true;
  forms.forEach(form => {
    form.addEventListener('input', () => updateSubmitState(form));
    form.addEventListener('change', () => updateSubmitState(form));
  });
  updateAllSubmitStates();
}

function epoch(time) {
  const now = new Date();
  const parts = time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1]).getTime() / 1000;
}

function initializeInputs(getArtifact) {
  artifactProvider = getArtifact;
  document.querySelectorAll('[data-events]').forEach(node => { node.innerHTML = eventRows(); });
  document.querySelectorAll('.mode-nav button').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.mode-nav button').forEach(item => item.classList.toggle('active', item === button));
    document.querySelector('#destination-view').classList.toggle('hidden', button.dataset.mode !== 'destination');
    document.querySelector('#distance-view').classList.toggle('hidden', button.dataset.mode !== 'distance');
  }));
  document.querySelectorAll('[data-time]').forEach(button => button.addEventListener('click', () => {
    button.closest('form').elements.departure_time.value = button.dataset.time;
  }));
  document.querySelectorAll('.current-time').forEach(button => button.addEventListener('click', () => {
    const now = new Date();
    button.closest('form').elements.departure_time.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }));
  initializeSubmitStates();
  if (!initialized) document.addEventListener('DOMContentLoaded', initializeSubmitStates, { once: true });
  window.addEventListener('pageshow', updateAllSubmitStates);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateAllSubmitStates();
  });
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const duration = seconds => {
  const minutes = Math.floor(seconds / 60 + 0.5);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}時間${String(minutes % 60).padStart(2, '0')}分` : `${minutes}分`;
};

const km = value => `${Number(value).toFixed(1)} km`;

function clock(departureEpoch, arrivalEpoch) {
  const date = new Date(arrivalEpoch * 1000);
  const days = Math.floor((arrivalEpoch - departureEpoch) / 86400);
  return `${days > 0 ? '翌日 ' : ''}${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function allocation(moving, natural, unexpected, planned) {
  const values = [
    [moving, '走行時間', 'moving-fill'],
    [natural, '通常停止時間', 'natural-fill'],
    [unexpected, '予備時間', 'unexpected-fill'],
    [planned, '予定イベント時間', 'planned-fill'],
  ];
  const total = values.reduce((sum, [value]) => sum + value, 0);
  if (total <= 0) return '<div class="notice">データがありません</div>';
  let x = 0;
  const visible = values.filter(([value]) => value > 0);
  return `<svg class="allocation" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="標準予測の時間配分">${visible.map(([value, label, style], index) => {
    const width = index === visible.length - 1 ? 100 - x : value / total * 100;
    const inside = width >= 22;
    const part = `<title>${label} ${duration(value)}</title><rect class="${style}" x="${x}" width="${width}" height="12"/>${inside ? `<text x="${x + width / 2}" y="7.2" text-anchor="middle" font-size="3">${duration(value)}</text>` : ''}`;
    x += width;
    return part;
  }).join('')}</svg>`;
}

function allocationLegend() {
  return '<ul class="allocation-legend" aria-label="内訳グラフの凡例"><li class="moving"><span aria-hidden="true">走</span>走行</li><li class="natural"><span aria-hidden="true">止</span>通常停止</li><li class="unexpected"><span aria-hidden="true">備</span>予備</li><li class="planned"><span aria-hidden="true">予</span>予定イベント</li></ul>';
}

const component = (kind, icon, title, copy, value) => `
  <div class="component ${kind}">
    <span class="icon">${icon}</span>
    <span class="copy"><strong>${title}</strong><br><small>${copy}</small></span>
    <span class="value">${value}</span>
  </div>`;

function warning(codes) {
  return codes.includes('residual_ols_long_distance_low_evidence')
    ? '<div class="notice">150km以上は過去の対象ライドが少なく、予測誤差が大きい可能性があります。</div>'
    : '';
}

function commonResult(result, primary, supporting, fixed, mode) {
  return `<section class="result">
    <h1>計算結果</h1>
    ${primary}
    ${supporting}
    ${fixed}
    <h2>所要時間の内訳（標準予測）</h2>
    ${allocation(result.moving_time_sec, result.natural_stop_time_sec, result.unexpected_buffer_sec, result.planned_event_time_sec)}
    ${allocationLegend()}
    <div class="breakdown">
      ${component('moving', '走', '走行時間', '過去の走行実績から距離に応じて推定', duration(result.moving_time_sec))}
      ${component('natural', '止', '通常停止時間', '走行中に自然に発生する停止時間を、距離帯ごとの過去実績から推定します。', duration(result.natural_stop_time_sec))}
      ${component('unexpected', '備', '予備時間', 'ユーザーが任意で追加する余裕時間です。', duration(result.unexpected_buffer_sec))}
      ${component('planned', '予', '予定イベント時間', 'ユーザーが事前入力したイベント時間の合計', duration(result.planned_event_time_sec))}
    </div>
    <p class="range-note">予定イベントと予備時間は、予測結果へそのまま加算します。</p>
    ${warning(result.warnings)}
    <div class="execution-save">
      <label>計画名（任意）<input data-snapshot-name maxlength="80" autocomplete="off"></label>
      <button class="secondary" type="button" data-save-snapshot="${mode}">この計画を実行用に保存</button>
      <p class="snapshot-status" aria-live="polite"></p>
    </div>
  </section>`;
}

const rangeBasis = '<small class="range-basis">過去実績から推定した目安です（必ず収まる範囲ではありません）</small>';

function renderDestinationResult(result, input) {
  const primary = `<div class="primary-result"><span>標準予測</span><strong>${duration(result.elapsed_time_sec)}</strong><b>${clock(input.epoch, result.arrival_at)} 帰宅</b></div>`;
  const supporting = `<div class="supporting-range"><strong>${duration(result.elapsed_lower_sec)} 〜 ${duration(result.elapsed_upper_sec)}</strong><small>${clock(input.epoch, result.arrival_lower_at)} 〜 ${clock(input.epoch, result.arrival_upper_at)}</small>${rangeBasis}</div>`;
  const fixed = `<p class="departure">出発 ${escapeHtml(input.departure_time)}</p>`;
  return commonResult(result, primary, supporting, fixed, 'destination');
}

function renderDistanceResult(result, input) {
  const primary = `<div class="primary-result"><span>標準予測</span><strong>${km(result.prototype_max_distance_km)}</strong></div>`;
  const supporting = `<div class="supporting-range"><strong>${km(result.distance_lower_km)} 〜 ${km(result.distance_upper_km)}</strong>${rangeBasis}</div>`;
  const fixed = `<div class="fixed"><div><span>出発時刻</span><br><strong>${escapeHtml(input.departure_time)}</strong></div><b>→</b><div><span>帰宅期限</span><br><strong>${escapeHtml(input.deadline_time)}</strong></div><div><span>利用可能時間</span><br><strong>${duration(result.available_time_sec)}</strong></div></div>`;
  return commonResult(result, primary, supporting, fixed, 'distance');
}

function reveal(node, html) {
  node.innerHTML = html;
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const escapeSnapshotHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const snapshotClock = epochSec => {
  const date = new Date(epochSec * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const createdAt = value => new Date(value).toLocaleString('ja-JP', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function snapshotHeading(record) {
  const name = record.display_name || '名称未設定の計画';
  const input = record.calculation.input;
  const target = record.calculation.mode === 'distance_to_time'
    ? `${Number(input.distance_km).toFixed(1)} km`
    : `帰宅期限 ${snapshotClock(input.return_deadline_epoch_sec)}`;
  return { name, target };
}

function renderSnapshotList(records) {
  const list = document.querySelector('#snapshot-list');
  if (!records.length) {
    list.innerHTML = '<p class="snapshot-empty">保存済みの実行用計画はありません。</p>';
    return;
  }
  list.innerHTML = [...records].reverse().map(record => {
    const { name, target } = snapshotHeading(record);
    const input = record.calculation.input;
    const result = record.calculation.result;
    const mode = record.calculation.mode === 'distance_to_time'
      ? '目的地までの時間' : '使える時間から距離';
    return `<details class="snapshot-item" data-snapshot-id="${record.execution_snapshot_id}">
      <summary><span><strong>${escapeSnapshotHtml(name)}</strong><small>${escapeSnapshotHtml(createdAt(record.created_at))}</small></span><b>${escapeSnapshotHtml(target)}</b></summary>
      <dl>
        <div><dt>計算方法</dt><dd>${mode}</dd></div>
        <div><dt>出発時刻</dt><dd>${escapeSnapshotHtml(snapshotClock(input.departure_epoch_sec))}</dd></div>
        <div><dt>標準予測</dt><dd>${Number(result.standard_distance_km).toFixed(1)} km・${Math.round(result.standard_elapsed_sec / 60)}分</dd></div>
        <div><dt>Snapshot ID</dt><dd class="snapshot-id">${record.execution_snapshot_id}</dd></div>
      </dl>
      <div class="snapshot-item-actions">
        <button type="button" class="secondary" data-copy-snapshot>コピーして再編集</button>
        <button type="button" class="secondary danger" data-delete-snapshot>削除</button>
      </div>
    </details>`;
  }).join('');
}

function updateSnapshotCount(message = '') {
  const count = document.querySelector('#snapshot-count');
  const status = document.querySelector('#snapshot-management-status');
  try {
    const records = loadExecutionSnapshots();
    count.textContent = `${records.length}件`;
    renderSnapshotList(records);
    status.textContent = message;
  } catch (error) {
    count.textContent = '読込エラー';
    status.textContent = error.message;
  }
}

function applyPlannedEvents(form, plannedEvents) {
  const byCode = new Map(plannedEvents.map(event => [event.event_code, event]));
  form.querySelectorAll('[name=selected_event]').forEach(box => {
    const event = byCode.get(box.value);
    box.checked = Boolean(event);
    if (event) form.elements[`event_${box.value}`].value = event.planned_duration_sec / 60;
  });
}

function copySnapshotToInputs(record, setSnapshotNameDraft) {
  const input = record.calculation.input;
  const destination = record.calculation.mode === 'distance_to_time';
  const mode = destination ? 'destination' : 'distance';
  document.querySelector(`[data-mode=${mode}]`).click();
  const form = document.querySelector(`#${mode}-form`);
  form.elements.departure_time.value = snapshotClock(input.departure_epoch_sec);
  if (destination) form.elements.distance_km.value = input.distance_km;
  else form.elements.deadline_time.value = snapshotClock(input.return_deadline_epoch_sec);
  applyPlannedEvents(form, input.planned_events);
  const hasReserve = input.reserve_time_sec > 0;
  const reserveField = form.elements.unexpected_buffer_minutes;
  form.elements.unexpected_enabled.checked = hasReserve;
  reserveField.value = hasReserve ? input.reserve_time_sec / 60 : reserveField.defaultValue;
  setSnapshotNameDraft(mode, record.display_name || '');
  form.dispatchEvent(new Event('input', { bubbles: true }));
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('#snapshot-management-status').textContent =
    '入力欄にコピーしました。内容を確認して再計算してください。';
}

function initializeSnapshotUi(currentCalculations, reproduction, setSnapshotNameDraft) {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-save-snapshot]');
    if (!button) return;
    const context = currentCalculations[button.dataset.saveSnapshot];
    const panel = button.closest('.execution-save');
    const status = panel.querySelector('.snapshot-status');
    if (!context) {
      status.textContent = '先に計算してください。';
      return;
    }
    button.disabled = true;
    try {
      const displayName = panel.querySelector('[data-snapshot-name]').value.trim();
      const payload = {
        display_name: displayName,
        calculation: context.calculation,
        reproduction: reproduction(),
      };
      const records = loadExecutionSnapshots();
      const latest = records[records.length - 1];
      if (latest && sameExecutionSnapshotContent(latest, payload)
          && displayName === (latest.display_name || '')) {
        status.textContent = '変更はありません。';
        return;
      }
      appendExecutionSnapshot(createExecutionSnapshot(payload));
      status.textContent = '実行用計画を保存しました。';
      updateSnapshotCount();
    } catch (error) {
      status.textContent = `保存できませんでした: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#snapshot-list').addEventListener('click', event => {
    const item = event.target.closest('[data-snapshot-id]');
    if (!item) return;
    try {
      const record = loadExecutionSnapshots().find(
        candidate => candidate.execution_snapshot_id === item.dataset.snapshotId,
      );
      if (!record) {
        updateSnapshotCount('対象の実行用計画が見つかりません。');
        return;
      }
      if (event.target.closest('[data-copy-snapshot]')) {
        copySnapshotToInputs(record, setSnapshotNameDraft);
        return;
      }
      if (!event.target.closest('[data-delete-snapshot]')) return;
      if (!confirm(`「${record.display_name || '名称未設定の計画'}」を削除します。元に戻せません。よろしいですか？`)) return;
      deleteExecutionSnapshot(record.execution_snapshot_id);
      updateSnapshotCount('実行用計画を削除しました。');
    } catch (error) {
      document.querySelector('#snapshot-management-status').textContent =
        `操作できませんでした: ${error.message}`;
    }
  });

  document.querySelector('#export-snapshots').addEventListener('click', () => {
    const status = document.querySelector('#snapshot-management-status');
    try {
      const records = loadExecutionSnapshots();
      if (!records.length) {
        status.textContent = '保存済みの実行用計画がありません。';
        return;
      }
      const url = URL.createObjectURL(new Blob([executionSnapshotsJsonl(records)], {
        type: 'application/x-ndjson;charset=utf-8',
      }));
      const link = document.createElement('a');
      link.href = url;
      link.download = executionSnapshotsFilename();
      link.click();
      URL.revokeObjectURL(url);
      status.textContent = `${records.length}件をJSONLで出力しました。`;
    } catch (error) {
      status.textContent = `出力できませんでした: ${error.message}`;
    }
  });

  document.querySelector('#delete-snapshots').addEventListener('click', () => {
    if (!confirm('保存済みの実行用計画をすべて削除します。元に戻せません。よろしいですか？')) return;
    const status = document.querySelector('#snapshot-management-status');
    try {
      deleteAllExecutionSnapshots();
      updateSnapshotCount('保存済みの実行用計画をすべて削除しました。');
    } catch (error) {
      status.textContent = `削除できませんでした: ${error.message}`;
    }
  });
  updateSnapshotCount();
}

let artifact;
let artifactSha256;
let buildInfo;
let serviceWorkerRegistration;

function getArtifact() {
  return artifact;
}

function reproduction() {
  if (!artifactSha256) throw new Error('予測データの確認完了後に保存してください。');
  return {
    app_version: APP_VERSION,
    runtime_artifact_id: artifact.source_identity.operational_release_id,
    runtime_artifact_sha256: artifactSha256,
    teacher_version: artifact.source_identity.operational_release_id,
    teacher_contract_version: artifact.source_identity.teacher_contract,
    calculation_contract_version: CALCULATION_CONTRACT_VERSION,
  };
}

const setText = (selector, value) => {
  const node = document.querySelector(selector);
  if (node) node.textContent = value || '取得不可';
};

const short = value => value && value !== 'unknown' ? value.slice(0, 12) : '取得不可';

const runtimeGeneration = value => {
  const match = String(value || '').match(/runtime-v(\d+)(?:$|[.-])/);
  return match ? Number(match[1]) : null;
};

const withTimeout = (promise, timeout, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label}がタイムアウトしました。`)), timeout);
  Promise.resolve(promise).then(value => {
    clearTimeout(timer);
    resolve(value);
  }, error => {
    clearTimeout(timer);
    reject(error);
  });
});

const fetchWithin = (url, label, timeout = 3000) => withTimeout(fetch(url, { cache: 'no-store' }), timeout, label);

async function sha256(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256確認は非対応です。');
  const digest = await withTimeout(crypto.subtle.digest('SHA-256', buffer), 3000, 'Artifact SHA確認');
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function showCompatibility(actualSha) {
  const compatible = Boolean(buildInfo && actualSha)
    && buildInfo.schema_version === 'ride-planning-build-info-v1'
    && buildInfo.expected_runtime_version === RUNTIME_VERSION
    && artifact?.runtime_version === RUNTIME_VERSION
    && buildInfo.expected_runtime_schema === artifact?.schema_version
    && buildInfo.ui_runtime_generation === runtimeGeneration(RUNTIME_VERSION)
    && buildInfo.artifact_sha256 === actualSha;
  document.querySelector('#cache-warning').classList.toggle('hidden', compatible);
  return compatible;
}

function workerMessage(worker, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Service Workerが未登録です。'));
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error(`Service Worker ${type}がタイムアウトしました。`)), timeout);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      resolve(event.data);
    };
    try {
      worker.postMessage({ type }, [channel.port2]);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function renderServiceWorkerInfo(registration) {
  const worker = navigator.serviceWorker.controller || registration?.active;
  try {
    const value = await workerMessage(worker, 'GET_VERSION');
    setText('#cache-id', value?.cacheId ? value.cacheId.replace('ride-planning-lab-', '') : '取得失敗');
    setText('#sw-version', value?.serviceWorkerVersion || '取得失敗');
    setText('#cache-updated-at', value?.cacheUpdatedAt || '取得失敗');
  } catch (error) {
    setText('#cache-id', worker ? '取得失敗' : '未登録');
    setText('#sw-version', worker ? '取得失敗' : '未登録');
    setText('#cache-updated-at', '取得失敗');
  }
}

async function waitForWaiting(registration, timeout = 5000) {
  if (registration.waiting) return registration.waiting;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(registration.waiting), timeout);
    const installing = registration.installing;
    if (!installing) {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' || installing.state === 'redundant') {
        clearTimeout(timer);
        resolve(registration.waiting);
      }
    });
  });
}

async function refreshAssets() {
  const button = document.querySelector('#refresh-assets');
  const status = document.querySelector('#refresh-status');
  button.disabled = true;
  status.textContent = '最新版を確認しています…';
  try {
    if (!('serviceWorker' in navigator)) throw new Error('Service Workerを利用できません。');
    const registration = serviceWorkerRegistration
      || await withTimeout(navigator.serviceWorker.ready, 3000, 'Service Worker登録');
    await withTimeout(registration.update(), 5000, 'Service Worker更新');
    const waiting = await waitForWaiting(registration);
    if (waiting) {
      const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      await workerMessage(waiting, 'ACTIVATE_UPDATE');
      await Promise.race([changed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    const refreshed = await workerMessage(
      navigator.serviceWorker.controller || registration.active, 'REFRESH_ASSETS', 10000,
    );
    if (!refreshed?.refreshed) throw new Error('最新assetを取得できませんでした。');
    status.textContent = '最新版を取得しました。再読み込みします…';
    location.reload();
  } catch (error) {
    status.textContent = `更新できませんでした: ${error?.message || '原因不明のエラー'}`;
    button.disabled = false;
  }
}

async function loadArtifact() {
  setText('#runtime-version', RUNTIME_VERSION);
  try {
    const response = await fetchWithin('./artifacts/ride_planning_runtime_v1.json', '予測データ');
    if (!response.ok) throw new Error(`予測データ取得失敗 (${response.status})`);
    const bytes = await withTimeout(response.arrayBuffer(), 3000, '予測データ読込');
    artifact = validateArtifact(JSON.parse(new TextDecoder().decode(bytes)));
    updateAllSubmitStates();
    try {
      const digest = await sha256(bytes);
      artifactSha256 = digest;
      setText('#artifact-sha', short(digest));
      return digest;
    } catch (error) {
      artifactSha256 = undefined;
      setText('#artifact-sha', error.message.includes('非対応') ? '非対応' : '取得失敗');
      return null;
    }
  } catch (error) {
    artifact = undefined;
    setText('#artifact-sha', '取得失敗');
    updateAllSubmitStates();
    const node = document.querySelector('#fatal');
    node.textContent = `${error.message} 初回利用またはcache消去後は、通信可能な状態で開き直してください。`;
    node.classList.remove('hidden');
    return null;
  }
}

async function loadBuildInfo() {
  try {
    const response = await fetchWithin('./build-info.json', 'ビルド情報');
    if (!response.ok) throw new Error(`ビルド情報取得失敗 (${response.status})`);
    buildInfo = await withTimeout(response.json(), 3000, 'ビルド情報読込');
    setText('#ui-version', `${buildInfo.ui_version} (${short(buildInfo.ui_commit)})`);
    setText('#build-time', buildInfo.build_at);
    return buildInfo;
  } catch (error) {
    buildInfo = undefined;
    setText('#ui-version', '取得失敗');
    setText('#build-time', '取得失敗');
    return null;
  }
}

async function initializeVersionInfo() {
  const [actualSha] = await Promise.all([loadArtifact(), loadBuildInfo()]);
  showCompatibility(actualSha);
}

async function initializeServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    setText('#cache-id', '非対応');
    setText('#sw-version', '非対応');
    setText('#cache-updated-at', '非対応');
    return;
  }
  try {
    await withTimeout((async () => {
      const registration = await navigator.serviceWorker.register('./service-worker.js');
      serviceWorkerRegistration = registration;
      const ready = await navigator.serviceWorker.ready;
      await renderServiceWorkerInfo(ready);
    })(), 3500, 'Service Worker情報');
  } catch (error) {
    setText('#cache-id', '取得失敗');
    setText('#sw-version', '取得失敗');
    setText('#cache-updated-at', '取得失敗');
  }
}

function initializeUpdateManager() {
  document.querySelector('#refresh-assets').addEventListener('click', refreshAssets);
  initializeVersionInfo();
  initializeServiceWorker();
  setTimeout(() => document.querySelectorAll('.version-panel dd').forEach(node => {
    if (node.textContent === '確認中') node.textContent = '取得失敗';
  }), 4000);
}

const currentCalculations = { destination: null, distance: null };
const snapshotNameDrafts = { destination: '', distance: '' };

function rememberSnapshotName(node, mode) {
  const field = node.querySelector('[data-snapshot-name]');
  if (field) snapshotNameDrafts[mode] = field.value;
}

function revealCalculation(node, html, mode) {
  reveal(node, html);
  const field = node.querySelector('[data-snapshot-name]');
  if (field) field.value = snapshotNameDrafts[mode];
}

function setSnapshotNameDraft(mode, value) {
  snapshotNameDrafts[mode] = value;
  const field = document.querySelector(`#${mode}-result [data-snapshot-name]`);
  if (field) field.value = value;
}

function destinationCalculation(result, distance, departureEpoch, events, reserveMinutes) {
  return {
    calculation: {
      mode: 'distance_to_time',
      input: {
        distance_km: distance,
        departure_epoch_sec: departureEpoch,
        planned_events: events.map(({ minutes, ...event }) => event),
        reserve_time_sec: reserveMinutes * 60,
      },
      result: {
        standard_elapsed_sec: result.elapsed_time_sec,
        lower_elapsed_sec: result.elapsed_lower_sec,
        upper_elapsed_sec: result.elapsed_upper_sec,
        standard_distance_km: result.distance_km,
        moving_time_sec: result.moving_time_sec,
        natural_stop_time_sec: result.natural_stop_time_sec,
        planned_event_time_sec: result.planned_event_time_sec,
        reserve_time_sec: result.unexpected_buffer_sec,
        standard_arrival_epoch_sec: result.arrival_at,
        lower_arrival_epoch_sec: result.arrival_lower_at,
        upper_arrival_epoch_sec: result.arrival_upper_at,
      },
    },
  };
}

function distanceCalculation(result, departureEpoch, deadlineEpoch, events, reserveMinutes) {
  return {
    calculation: {
      mode: 'time_to_distance',
      input: {
        departure_epoch_sec: departureEpoch,
        return_deadline_epoch_sec: deadlineEpoch,
        available_time_sec: result.available_time_sec,
        planned_events: events.map(({ minutes, ...event }) => event),
        reserve_time_sec: reserveMinutes * 60,
      },
      result: {
        standard_elapsed_sec: result.elapsed_time_sec,
        standard_distance_km: result.prototype_max_distance_km,
        lower_distance_km: result.distance_lower_km,
        upper_distance_km: result.distance_upper_km,
        moving_time_sec: result.moving_time_sec,
        natural_stop_time_sec: result.natural_stop_time_sec,
        planned_event_time_sec: result.planned_event_time_sec,
        reserve_time_sec: result.unexpected_buffer_sec,
      },
    },
  };
}

document.querySelector('#destination-form').addEventListener('submit', event => {
  event.preventDefault();
  const node = document.querySelector('#destination-result');
  rememberSnapshotName(node, 'destination');
  currentCalculations.destination = null;
  try {
    const form = event.currentTarget;
    const distance = Number(form.elements.distance_km.value);
    const departureTime = form.elements.departure_time.value;
    const departureEpoch = epoch(departureTime);
    const events = selectedEvents(form);
    const reserveMinutes = unexpectedMinutes(form);
    const result = estimateDestination({
      distance_km: distance,
      departure_epoch_sec: departureEpoch,
      event_minutes: events.map(item => item.minutes),
      unexpected_buffer_minutes: reserveMinutes,
    }, getArtifact());
    currentCalculations.destination = destinationCalculation(
      result, distance, departureEpoch, events, reserveMinutes,
    );
    revealCalculation(node, renderDestinationResult(result, {
      departure_time: departureTime,
      epoch: departureEpoch,
    }), 'destination');
  } catch (error) {
    reveal(node, `<div class="error">${escapeHtml(error.message)}</div>`);
  }
});

document.querySelector('#distance-form').addEventListener('submit', event => {
  event.preventDefault();
  const node = document.querySelector('#distance-result');
  rememberSnapshotName(node, 'distance');
  currentCalculations.distance = null;
  try {
    const form = event.currentTarget;
    const departureTime = form.elements.departure_time.value;
    const deadlineTime = form.elements.deadline_time.value;
    const departureEpoch = epoch(departureTime);
    const deadlineEpoch = epoch(deadlineTime);
    if (deadlineEpoch <= departureEpoch) {
      throw new Error('帰宅期限は出発時刻より後にしてください。');
    }
    const events = selectedEvents(form);
    const reserveMinutes = unexpectedMinutes(form);
    const result = estimateDistance({
      departure_epoch_sec: departureEpoch,
      deadline_epoch_sec: deadlineEpoch,
      event_minutes: events.map(item => item.minutes),
      unexpected_buffer_minutes: reserveMinutes,
    }, getArtifact());
    currentCalculations.distance = distanceCalculation(
      result, departureEpoch, deadlineEpoch, events, reserveMinutes,
    );
    revealCalculation(node, renderDistanceResult(result, {
      departure_time: departureTime,
      deadline_time: deadlineTime,
    }), 'distance');
  } catch (error) {
    reveal(node, `<div class="error">${escapeHtml(error.message)}</div>`);
  }
});

initializeInputs(getArtifact);
initializeSnapshotUi(currentCalculations, reproduction, setSnapshotNameDraft);
initializeUpdateManager();
