import {ARTIFACT_SCHEMA_VERSION, RUNTIME_VERSION, estimateDestination, estimateDistance, validateArtifact} from './runtime/ride_planning_runtime.js?v=ride-planning-ui-v32';
import {APP_VERSION, CALCULATION_CONTRACT_VERSION, appendExecutionSnapshot, createExecutionSnapshot, deleteAllExecutionSnapshots, deleteExecutionSnapshot, executionSnapshotsFilename, executionSnapshotsJsonl, loadExecutionSnapshots, sameExecutionSnapshotContent} from './execution_snapshots.js?v=ride-planning-ui-v32';

const presets = [
  ['collection', 'カード収集', 10, true],
  ['lunch', '昼食', 40, true],
  ['snack', '軽食', 20, false],
  ['sightseeing', '観光・見学', 30, false],
  ['other', 'その他', 10, false],
];

const plannedEventTypes = Object.freeze(
  presets.map(([event_code, label]) => Object.freeze({ event_code, label })),
);

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

function allocationLegend(simple = false) {
  return `<ul class="allocation-legend" aria-label="内訳グラフの凡例"><li class="moving"><span aria-hidden="true">${simple ? '基' : '走'}</span>${simple ? '基準時間' : '走行'}</li>${simple ? '' : '<li class="natural"><span aria-hidden="true">止</span>通常停止</li>'}<li class="unexpected"><span aria-hidden="true">備</span>予備</li><li class="planned"><span aria-hidden="true">予</span>予定イベント</li></ul>`;
}

const component = (kind, icon, title, copy, value) => `
  <div class="component ${kind}">
    <span class="icon">${icon}</span>
    <span class="copy"><strong>${title}</strong><br><small>${copy}</small></span>
    <span class="value">${value}</span>
  </div>`;

function warning(codes) {
  if (codes.includes('simple_prediction_trial')) {
    return '<div class="notice">簡易モデルは暫定比較用です。実走条件や安全を保証するものではありません。</div>';
  }
  return codes.includes('residual_ols_long_distance_low_evidence')
    ? '<div class="notice">150km以上は過去の対象ライドが少なく、予測誤差が大きい可能性があります。</div>'
    : '';
}

function commonResult(result, primary, supporting, fixed, mode) {
  const simple = result.prediction_model === 'simple-origin-linear-v2';
  const save = `<div class="execution-save">
      <label>計画名（任意）<input data-snapshot-name maxlength="80" autocomplete="off"></label>
      <p class="plan-context" data-plan-context>新しい計画</p>
      <button class="secondary" type="button" data-save-plan="${mode}">保存</button>
      <button class="secondary hidden" type="button" data-save-plan-as-new="${mode}">別の計画として保存</button>
      <p class="snapshot-status" aria-live="polite"></p>
    </div>`;
  return `<section class="result">
    <h1>計算結果</h1>
    ${simple ? '<p class="result-model">簡易モデル（暫定）</p>' : ''}
    ${primary}
    ${supporting}
    ${fixed}
    <h2>所要時間の内訳（標準予測）</h2>
    ${allocation(result.moving_time_sec, result.natural_stop_time_sec, result.unexpected_buffer_sec, result.planned_event_time_sec)}
    ${allocationLegend(simple)}
    <div class="breakdown">
      ${component('moving', simple ? '基' : '走', simple ? '基準時間' : '走行時間', simple ? '距離を設定した基準速度で割った時間です。' : '過去の走行実績から距離に応じて推定', duration(result.moving_time_sec))}
      ${simple ? '' : component('natural', '止', '通常停止時間', '走行中に自然に発生する停止時間を、距離帯ごとの過去実績から推定します。', duration(result.natural_stop_time_sec))}
      ${component('unexpected', '備', '予備時間', 'ユーザーが任意で追加する余裕時間です。', duration(result.unexpected_buffer_sec))}
      ${component('planned', '予', '予定イベント時間', 'ユーザーが事前入力したイベント時間の合計', duration(result.planned_event_time_sec))}
    </div>
    <p class="range-note">予定イベントと予備時間は、予測結果へそのまま加算します。</p>
    ${warning(result.warnings)}
    ${save}
  </section>`;
}

function renderDestinationResult(result, input) {
  const primary = `<div class="primary-result"><span>標準予測</span><strong>${duration(result.elapsed_time_sec)}</strong><b>${clock(input.epoch, result.arrival_at)} 帰宅</b></div>`;
  const supporting = `<div class="supporting-range"><strong>${duration(result.elapsed_lower_sec)} 〜 ${duration(result.elapsed_upper_sec)}</strong><small>${clock(input.epoch, result.arrival_lower_at)} 〜 ${clock(input.epoch, result.arrival_upper_at)}</small></div>`;
  const fixed = `<p class="departure">出発 ${escapeHtml(input.departure_time)}</p>`;
  return commonResult(result, primary, supporting, fixed, 'destination');
}

function renderDistanceResult(result, input) {
  const primary = `<div class="primary-result"><span>標準予測</span><strong>${km(result.prototype_max_distance_km)}</strong></div>`;
  const supporting = `<div class="supporting-range"><strong>${km(result.distance_lower_km)} 〜 ${km(result.distance_upper_km)}</strong></div>`;
  const fixed = `<div class="fixed"><div><span>出発時刻</span><br><strong>${escapeHtml(input.departure_time)}</strong></div><b>→</b><div><span>帰宅期限</span><br><strong>${escapeHtml(input.deadline_time)}</strong></div><div><span>利用可能時間</span><br><strong>${duration(result.available_time_sec)}</strong></div></div>`;
  return commonResult(result, primary, supporting, fixed, 'distance');
}

function reveal(node, html) {
  node.innerHTML = html;
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const RIDE_PLAN_CATALOG_SCHEMA_VERSION = 'ride-plan-catalog-store-v1';
const RIDE_PLAN_CATALOG_STORAGE_KEY = 'ride-planning-lab-ride-plans-v1';
const RIDE_PLAN_CATALOG_EXPORT_SCHEMA_VERSION = 'ride-plan-catalog-export-v1';
const RIDE_PLANNING_BACKUP_SCHEMA_VERSION = 'ride-planning-backup-v1';

const clone = value => JSON.parse(JSON.stringify(value));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function newUuid(cryptoObject = globalThis.crypto) {
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  if (!cryptoObject?.getRandomValues) throw new Error('このブラウザでは計画IDを作成できません。');
  const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  return [...bytes].map((value, index) =>
    (index === 4 || index === 6 || index === 8 || index === 10 ? '-' : '')
      + value.toString(16).padStart(2, '0')).join('');
}

function validatePlan(plan) {
  if (!plan || !uuidPattern.test(plan.ride_plan_id || '')) throw new Error('保存した計画のIDが不正です。');
  if (typeof plan.title !== 'string' || plan.title.length > 80) throw new Error('保存した計画の名前が不正です。');
  if (!Array.isArray(plan.execution_snapshot_ids) || !plan.execution_snapshot_ids.length) {
    throw new Error('保存した計画の履歴が不正です。');
  }
  if (!plan.execution_snapshot_ids.every(id => uuidPattern.test(id))) throw new Error('保存した計画の履歴IDが不正です。');
  if (new Set(plan.execution_snapshot_ids).size !== plan.execution_snapshot_ids.length) throw new Error('保存した計画の履歴が重複しています。');
  if (plan.current_execution_snapshot_id !== plan.execution_snapshot_ids[plan.execution_snapshot_ids.length - 1]) {
    throw new Error('保存した計画の現在履歴が不正です。');
  }
  for (const key of ['created_at', 'updated_at']) {
    if (typeof plan[key] !== 'string' || !Number.isFinite(Date.parse(plan[key]))) throw new Error('保存した計画の日時が不正です。');
  }
  if (plan.deleted_at !== undefined
      && (typeof plan.deleted_at !== 'string' || !Number.isFinite(Date.parse(plan.deleted_at)))) {
    throw new Error('保存した計画の削除日時が不正です。');
  }
  return plan;
}

function validateCatalog(catalog, snapshots) {
  if (catalog?.schema_version !== RIDE_PLAN_CATALOG_SCHEMA_VERSION || !Array.isArray(catalog.plans)) {
    throw new Error('保存した計画の一覧形式が不正です。既存データは変更していません。');
  }
  const snapshotIds = new Set(snapshots.map(record => record.execution_snapshot_id));
  const planIds = new Set();
  const claimed = new Set();
  catalog.plans.forEach(plan => {
    validatePlan(plan);
    if (planIds.has(plan.ride_plan_id)) throw new Error('保存した計画のIDが重複しています。');
    planIds.add(plan.ride_plan_id);
    plan.execution_snapshot_ids.forEach(id => {
      if (!snapshotIds.has(id)) throw new Error('保存した計画が存在しない履歴を参照しています。');
      if (claimed.has(id)) throw new Error('同じ履歴が複数の計画に含まれています。');
      claimed.add(id);
    });
  });
  return catalog;
}

function ridePlanCatalogExport(catalog, snapshots, exportedAt = new Date().toISOString()) {
  validateCatalog(catalog, snapshots);
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error('バックアップ日時が不正です。');
  return {
    schema_version: RIDE_PLAN_CATALOG_EXPORT_SCHEMA_VERSION,
    record_type: 'ride_plan_catalog',
    exported_at: exportedAt,
    catalog: clone(catalog),
  };
}

function ridePlanCatalogJson(catalog, snapshots, exportedAt) {
  return `${JSON.stringify(ridePlanCatalogExport(catalog, snapshots, exportedAt), null, 2)}\n`;
}

function ridePlanCatalogFilename(now = new Date()) {
  return `ride-plan-catalog-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
}

function ridePlanningBackupJson(catalog, snapshots, exportedAt = new Date().toISOString()) {
  const catalogExport = ridePlanCatalogExport(catalog, snapshots, exportedAt);
  return `${JSON.stringify({
    schema_version: RIDE_PLANNING_BACKUP_SCHEMA_VERSION,
    record_type: 'ride_planning_backup',
    exported_at: exportedAt,
    execution_snapshots: clone(snapshots),
    ride_plan_catalog: catalogExport,
  }, null, 2)}\n`;
}

function ridePlanningBackupFilename(now = new Date()) {
  return `ride-planning-backup-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
}

function parseRidePlanningBackupJson(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error('バックアップファイルを読み取れません。既存データは変更していません。');
  }
  if (value?.schema_version !== RIDE_PLANNING_BACKUP_SCHEMA_VERSION
      || value.record_type !== 'ride_planning_backup') {
    throw new Error('Ride Reviewに必要なバックアップ形式ではありません。既存データは変更していません。');
  }
  if (!Array.isArray(value.execution_snapshots) || !value.execution_snapshots.length) {
    throw new Error('バックアップに予測履歴が含まれていません。Ride Reviewに必要なバックアップではありません。');
  }
  if (!value.ride_plan_catalog) {
    throw new Error('バックアップに保存した計画の情報が含まれていません。Ride Reviewに必要なバックアップではありません。');
  }
  validateCatalog(value.ride_plan_catalog.catalog, value.execution_snapshots);
  return clone(value);
}

function importRidePlanCatalogJson(text, snapshots, storage = globalThis.localStorage) {
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error('RidePlanバックアップを読み取れません。既存データは変更していません。');
  }
  if (value?.schema_version !== RIDE_PLAN_CATALOG_EXPORT_SCHEMA_VERSION
      || value.record_type !== 'ride_plan_catalog'
      || !Number.isFinite(Date.parse(value.exported_at))) {
    throw new Error('RidePlanバックアップ形式が不正です。既存データは変更していません。');
  }
  validateCatalog(value.catalog, snapshots);
  const storedCatalog = storage.getItem(RIDE_PLAN_CATALOG_STORAGE_KEY);
  const existing = storedCatalog === null
    ? {schema_version: RIDE_PLAN_CATALOG_SCHEMA_VERSION, plans: []}
    : loadRidePlanCatalog(snapshots, storage);
  const merged = clone(existing);
  const byId = new Map(merged.plans.map(plan => [plan.ride_plan_id, plan]));
  for (const imported of value.catalog.plans) {
    const current = byId.get(imported.ride_plan_id);
    if (!current) {
      const added = clone(imported);
      merged.plans.push(added);
      byId.set(added.ride_plan_id, added);
      continue;
    }
    if (current.created_at !== imported.created_at) {
      throw new Error('同じRidePlan IDの作成日時が異なります。既存データは変更していません。');
    }
    const shorter = current.execution_snapshot_ids.length <= imported.execution_snapshot_ids.length
      ? current : imported;
    const longer = shorter === current ? imported : current;
    if (!shorter.execution_snapshot_ids.every((id, index) => longer.execution_snapshot_ids[index] === id)) {
      throw new Error('同じRidePlan IDの保存履歴が分岐しています。既存データは変更していません。');
    }
    const chosen = current.execution_snapshot_ids.length === imported.execution_snapshot_ids.length
      ? (Date.parse(imported.updated_at) > Date.parse(current.updated_at) ? imported : current)
      : longer;
    Object.assign(current, clone(chosen));
  }
  validateCatalog(merged, snapshots);
  saveRidePlanCatalog(merged, snapshots, storage);
  return clone(merged);
}

const migrationKey = record => {
  const name = (record.display_name || '').trim();
  return name ? `${record.calculation.mode}\n${name.toLocaleLowerCase('ja-JP')}` : null;
};

function migrateExecutionSnapshotsToRidePlans(snapshots, { cryptoObject = globalThis.crypto } = {}) {
  const plans = [];
  const grouped = new Map();
  snapshots.forEach(record => {
    const key = migrationKey(record);
    let plan = key ? grouped.get(key) : undefined;
    if (!plan) {
      plan = {
        ride_plan_id: newUuid(cryptoObject),
        title: record.display_name || '',
        created_at: record.created_at,
        updated_at: record.created_at,
        current_execution_snapshot_id: record.execution_snapshot_id,
        execution_snapshot_ids: [],
      };
      plans.push(plan);
      if (key) grouped.set(key, plan);
    }
    plan.execution_snapshot_ids.push(record.execution_snapshot_id);
    plan.current_execution_snapshot_id = record.execution_snapshot_id;
    plan.updated_at = record.created_at;
  });
  return validateCatalog({ schema_version: RIDE_PLAN_CATALOG_SCHEMA_VERSION, plans }, snapshots);
}

function saveRidePlanCatalog(catalog, snapshots, storage = globalThis.localStorage) {
  validateCatalog(catalog, snapshots);
  storage.setItem(RIDE_PLAN_CATALOG_STORAGE_KEY, JSON.stringify(catalog));
  return clone(catalog);
}

function loadRidePlanCatalog(snapshots, storage = globalThis.localStorage,
                                    options = {}) {
  const raw = storage.getItem(RIDE_PLAN_CATALOG_STORAGE_KEY);
  if (raw === null) {
    const migrated = migrateExecutionSnapshotsToRidePlans(snapshots, options);
    storage.setItem(RIDE_PLAN_CATALOG_STORAGE_KEY, JSON.stringify(migrated));
    return clone(migrated);
  }
  let catalog;
  try { catalog = JSON.parse(raw); } catch (error) {
    throw new Error('保存した計画の一覧を読み取れません。既存データは変更していません。');
  }
  validateCatalog(catalog, snapshots);
  const claimed = new Set(catalog.plans.flatMap(plan => plan.execution_snapshot_ids));
  const orphans = snapshots.filter(record => !claimed.has(record.execution_snapshot_id));
  if (orphans.length) {
    const additions = migrateExecutionSnapshotsToRidePlans(orphans, options).plans;
    catalog = { ...catalog, plans: [...catalog.plans, ...additions] };
    saveRidePlanCatalog(catalog, snapshots, storage);
  }
  return clone(catalog);
}

function createRidePlan(catalog, snapshot, title,
                               { cryptoObject = globalThis.crypto } = {}) {
  const plan = {
    ride_plan_id: newUuid(cryptoObject),
    title,
    created_at: snapshot.created_at,
    updated_at: snapshot.created_at,
    current_execution_snapshot_id: snapshot.execution_snapshot_id,
    execution_snapshot_ids: [snapshot.execution_snapshot_id],
  };
  return { ...clone(catalog), plans: [...clone(catalog.plans), plan] };
}

function updateRidePlan(catalog, ridePlanId, snapshot, title) {
  let found = false;
  const plans = catalog.plans.map(plan => {
    if (plan.ride_plan_id !== ridePlanId || plan.deleted_at) return clone(plan);
    found = true;
    return {
      ...clone(plan),
      title,
      updated_at: snapshot.created_at,
      current_execution_snapshot_id: snapshot.execution_snapshot_id,
      execution_snapshot_ids: [...plan.execution_snapshot_ids, snapshot.execution_snapshot_id],
    };
  });
  if (!found) throw new Error('保存先の計画が見つかりません。');
  return { ...clone(catalog), plans };
}

function removeRidePlan(catalog, ridePlanId, deletedAt = new Date().toISOString()) {
  let found = false;
  const plans = catalog.plans.map(plan => {
    if (plan.ride_plan_id !== ridePlanId || plan.deleted_at) return clone(plan);
    found = true;
    return { ...clone(plan), deleted_at: deletedAt };
  });
  if (!found) throw new Error('削除する計画が見つかりません。');
  return { ...clone(catalog), plans };
}

function deleteRidePlanCatalog(storage = globalThis.localStorage) {
  storage.removeItem(RIDE_PLAN_CATALOG_STORAGE_KEY);
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

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).filter(([, value]) => value !== null));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function restoreRidePlanningBackup(text, storage = globalThis.localStorage) {
  const backup = parseRidePlanningBackupJson(text);
  const previousSnapshots = storage.getItem(SNAPSHOT_STORAGE_KEY);
  const previousCatalog = storage.getItem(RIDE_PLAN_CATALOG_STORAGE_KEY);
  const previous = {
    [SNAPSHOT_STORAGE_KEY]: previousSnapshots,
    [RIDE_PLAN_CATALOG_STORAGE_KEY]: previousCatalog,
  };
  let staged = memoryStorage(previous);
  let recoveredCorruptStorage = false;
  try {
    const validationStorage = memoryStorage(previous);
    const currentRecords = loadExecutionSnapshots(validationStorage);
    loadRidePlanCatalog(currentRecords, validationStorage);
  } catch (error) {
    staged = memoryStorage();
    recoveredCorruptStorage = true;
  }
  const result = importExecutionSnapshotsJsonl(
    executionSnapshotsJsonl(backup.execution_snapshots), staged,
  );
  const catalog = importRidePlanCatalogJson(
    JSON.stringify(backup.ride_plan_catalog), loadExecutionSnapshots(staged), staged,
  );
  try {
    storage.setItem(SNAPSHOT_STORAGE_KEY, staged.getItem(SNAPSHOT_STORAGE_KEY));
    storage.setItem(RIDE_PLAN_CATALOG_STORAGE_KEY, staged.getItem(RIDE_PLAN_CATALOG_STORAGE_KEY));
  } catch (error) {
    if (previousSnapshots === null) storage.removeItem(SNAPSHOT_STORAGE_KEY);
    else storage.setItem(SNAPSHOT_STORAGE_KEY, previousSnapshots);
    if (previousCatalog === null) storage.removeItem(RIDE_PLAN_CATALOG_STORAGE_KEY);
    else storage.setItem(RIDE_PLAN_CATALOG_STORAGE_KEY, previousCatalog);
    throw error;
  }
  return { result, catalog, recoveredCorruptStorage };
}

const currentSnapshot = (plan, recordsById) => recordsById.get(plan.current_execution_snapshot_id);

function planHeading(plan, record) {
  const name = plan.title || '名称未設定の計画';
  const input = record.calculation.input;
  const target = record.calculation.mode === 'distance_to_time'
    ? `${Number(input.distance_km).toFixed(1)} km`
    : `帰宅期限 ${snapshotClock(input.return_deadline_epoch_sec)}`;
  return { name, target };
}

function renderRidePlanList(catalog, records) {
  const list = document.querySelector('#snapshot-list');
  const visiblePlans = catalog.plans.filter(plan => !plan.deleted_at);
  if (!visiblePlans.length) {
    list.innerHTML = '<p class="snapshot-empty">保存した計画はありません。</p>';
    return;
  }
  const recordsById = new Map(records.map(record => [record.execution_snapshot_id, record]));
  list.innerHTML = visiblePlans.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)).map(plan => {
    const record = currentSnapshot(plan, recordsById);
    const { name, target } = planHeading(plan, record);
    const input = record.calculation.input;
    const result = record.calculation.result;
    const mode = record.calculation.mode === 'distance_to_time'
      ? '目的地までの時間' : '使える時間から距離';
    return `<details class="snapshot-item" data-ride-plan-id="${plan.ride_plan_id}">
      <summary><span><strong>${escapeSnapshotHtml(name)}</strong><small>最終保存 ${escapeSnapshotHtml(createdAt(plan.updated_at))}</small></span><b>${escapeSnapshotHtml(target)}</b></summary>
      <dl>
        <div><dt>計算方法</dt><dd>${mode}</dd></div>
        <div><dt>出発時刻</dt><dd>${escapeSnapshotHtml(snapshotClock(input.departure_epoch_sec))}</dd></div>
        <div><dt>標準予測</dt><dd>${Number(result.standard_distance_km).toFixed(1)} km・${Math.round(result.standard_elapsed_sec / 60)}分</dd></div>
        <div><dt>保存履歴</dt><dd>${plan.execution_snapshot_ids.length}件</dd></div>
      </dl>
      <div class="snapshot-item-actions">
        <button type="button" class="secondary" data-open-plan>開く</button>
        <button type="button" class="secondary danger" data-delete-plan>削除</button>
      </div>
    </details>`;
  }).join('');
}

function loadState() {
  const records = loadExecutionSnapshots();
  return { records, catalog: loadRidePlanCatalog(records) };
}

function updatePlanCount(message = '') {
  const count = document.querySelector('#snapshot-count');
  const status = document.querySelector('#snapshot-management-status');
  try {
    const { records, catalog } = loadState();
    count.textContent = `${catalog.plans.filter(plan => !plan.deleted_at).length}件`;
    renderRidePlanList(catalog, records);
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

function openPlan(record, plan, setSnapshotNameDraft) {
  const input = record.calculation.input;
  document.dispatchEvent(new CustomEvent('rideplanning:load-model', { detail: {
    prediction_model: input.prediction_model || 'current',
    simple_model_parameters: input.simple_model_parameters,
  } }));
  const destination = record.calculation.mode === 'distance_to_time';
  const mode = destination ? 'destination' : 'distance';
  document.querySelector(`[data-mode=${mode}]`).click();
  const form = document.querySelector(`#${mode}-form`);
  if (input.itinerary) {
    setSnapshotNameDraft(mode, plan.title);
    document.dispatchEvent(new CustomEvent('rideplanning:load-itinerary', { detail: input.itinerary }));
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (destination) document.querySelector('[data-input-mode=simple]').click();
  form.elements.departure_time.value = snapshotClock(input.departure_epoch_sec);
  if (destination) form.elements.distance_km.value = input.distance_km;
  else form.elements.deadline_time.value = snapshotClock(input.return_deadline_epoch_sec);
  applyPlannedEvents(form, input.planned_events);
  const hasReserve = input.reserve_time_sec > 0;
  const reserveField = form.elements.unexpected_buffer_minutes;
  form.elements.unexpected_enabled.checked = hasReserve;
  reserveField.value = hasReserve ? input.reserve_time_sec / 60 : reserveField.defaultValue;
  setSnapshotNameDraft(mode, plan.title);
  form.dispatchEvent(new Event('input', { bubbles: true }));
  form.requestSubmit();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initializeSnapshotUi(currentCalculations, reproduction, setSnapshotNameDraft) {
  let activeRidePlanId = null;

  function refreshSaveControls() {
    document.querySelectorAll('.execution-save').forEach(panel => {
      const context = panel.querySelector('[data-plan-context]');
      const save = panel.querySelector('[data-save-plan]');
      const saveAsNew = panel.querySelector('[data-save-plan-as-new]');
      if (activeRidePlanId) {
        let plan;
        try {
          const { catalog } = loadState();
          plan = catalog.plans.find(candidate =>
            candidate.ride_plan_id === activeRidePlanId && !candidate.deleted_at);
        } catch (error) {
          plan = null;
        }
        context.textContent = plan ? `編集中: ${plan.title || '名称未設定の計画'}` : '新しい計画';
        save.textContent = plan ? '変更を保存' : '保存';
        saveAsNew.classList.toggle('hidden', !plan);
      } else {
        context.textContent = '新しい計画';
        save.textContent = '保存';
        saveAsNew.classList.add('hidden');
      }
    });
  }

  function savePlan(button, asNew) {
    const mode = button.dataset.savePlan || button.dataset.savePlanAsNew;
    const context = currentCalculations[mode];
    const panel = button.closest('.execution-save');
    const status = panel.querySelector('.snapshot-status');
    if (!context) {
      status.textContent = '先に計算してください。';
      return;
    }
    button.disabled = true;
    try {
      const title = panel.querySelector('[data-snapshot-name]').value.trim();
      const payload = { display_name: title, calculation: context.calculation,
        reproduction: context.reproduction || reproduction() };
      const { records, catalog } = loadState();
      const plan = !asNew && activeRidePlanId
        ? catalog.plans.find(candidate =>
          candidate.ride_plan_id === activeRidePlanId && !candidate.deleted_at) : null;
      const previous = plan
        ? records.find(record => record.execution_snapshot_id === plan.current_execution_snapshot_id) : null;
      if (previous && sameExecutionSnapshotContent(previous, payload)
          && title === plan.title) {
        status.textContent = '変更はありません。';
        return;
      }
      const snapshot = createExecutionSnapshot(payload);
      appendExecutionSnapshot(snapshot);
      const nextRecords = [...records, snapshot];
      const nextCatalog = plan
        ? updateRidePlan(catalog, plan.ride_plan_id, snapshot, title)
        : createRidePlan(catalog, snapshot, title);
      saveRidePlanCatalog(nextCatalog, nextRecords);
      activeRidePlanId = plan ? plan.ride_plan_id
        : nextCatalog.plans[nextCatalog.plans.length - 1].ride_plan_id;
      status.textContent = plan ? '変更を保存しました。' : '計画を保存しました。';
      updatePlanCount();
      refreshSaveControls();
    } catch (error) {
      status.textContent = `保存できませんでした: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', event => {
    const save = event.target.closest('[data-save-plan]');
    const saveAsNew = event.target.closest('[data-save-plan-as-new]');
    if (save || saveAsNew) savePlan(save || saveAsNew, Boolean(saveAsNew));
  });

  document.querySelector('#snapshot-list').addEventListener('click', event => {
    const item = event.target.closest('[data-ride-plan-id]');
    if (!item) return;
    try {
      const { records, catalog } = loadState();
      const plan = catalog.plans.find(candidate =>
        candidate.ride_plan_id === item.dataset.ridePlanId && !candidate.deleted_at);
      if (!plan) {
        updatePlanCount('対象の計画が見つかりません。');
        return;
      }
      if (event.target.closest('[data-open-plan]')) {
        const record = records.find(candidate =>
          candidate.execution_snapshot_id === plan.current_execution_snapshot_id);
        activeRidePlanId = plan.ride_plan_id;
        openPlan(record, plan, setSnapshotNameDraft);
        refreshSaveControls();
        document.querySelector('#snapshot-management-status').textContent =
          '計画を開きました。編集後に「変更を保存」を選んでください。';
        return;
      }
      if (!event.target.closest('[data-delete-plan]')) return;
      if (!confirm(`「${plan.title || '名称未設定の計画'}」を削除します。予測履歴は互換データとして保持されます。よろしいですか？`)) return;
      const nextCatalog = removeRidePlan(catalog, plan.ride_plan_id);
      saveRidePlanCatalog(nextCatalog, records);
      if (activeRidePlanId === plan.ride_plan_id) activeRidePlanId = null;
      updatePlanCount('保存した計画を削除しました。');
      refreshSaveControls();
    } catch (error) {
      document.querySelector('#snapshot-management-status').textContent =
        `操作できませんでした: ${error.message}`;
    }
  });

  document.querySelector('#export-backup').addEventListener('click', () => {
    const status = document.querySelector('#snapshot-management-status');
    try {
      const records = loadExecutionSnapshots();
      if (!records.length) {
        status.textContent = '保存した計画がありません。';
        return;
      }
      const { catalog } = loadState();
      const url = URL.createObjectURL(new Blob([ridePlanningBackupJson(catalog, records)], {
        type: 'application/json;charset=utf-8',
      }));
      const link = document.createElement('a');
      link.href = url;
      link.download = ridePlanningBackupFilename();
      link.click();
      URL.revokeObjectURL(url);
      status.textContent = `${catalog.plans.length}件の保存した計画をバックアップしました。`;
    } catch (error) {
      status.textContent = `出力できませんでした: ${error.message}`;
    }
  });

  document.querySelector('#import-backup').addEventListener('change', async event => {
    const status = document.querySelector('#snapshot-management-status');
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const { result, catalog } = restoreRidePlanningBackup(await file.text());
      activeRidePlanId = null;
      updatePlanCount(`${catalog.plans.filter(plan => !plan.deleted_at).length}件の保存した計画を復元しました（予測履歴 新規${result.imported}件）。`);
      refreshSaveControls();
    } catch (error) {
      status.textContent = `復元できませんでした: ${error.message}`;
    } finally {
      event.target.value = '';
    }
  });

  document.querySelector('#delete-snapshots').addEventListener('click', () => {
    if (!confirm('保存した計画と端末内の予測履歴をすべて削除します。元に戻せません。よろしいですか？')) return;
    const status = document.querySelector('#snapshot-management-status');
    try {
      deleteAllExecutionSnapshots();
      deleteRidePlanCatalog();
      activeRidePlanId = null;
      updatePlanCount('保存した計画をすべて削除しました。');
      refreshSaveControls();
    } catch (error) {
      status.textContent = `削除できませんでした: ${error.message}`;
    }
  });

  updatePlanCount();
  return { refreshSaveControls };
}

let artifact;
let artifactSha256;
let buildInfo;
let serviceWorkerRegistration;
let rawArtifact;
let artifactUrl;

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

function renderArtifactDiagnostic(status, raw = rawArtifact, digest = artifactSha256) {
  setText('#artifact-validation-status', status);
  setText('#diagnostic-runtime-expected', RUNTIME_VERSION);
  setText('#diagnostic-schema-expected', ARTIFACT_SCHEMA_VERSION);
  setText('#diagnostic-artifact-runtime', raw?.runtime_version || '取得不可');
  setText('#diagnostic-artifact-schema', raw?.schema_version || '取得不可');
  setText('#diagnostic-artifact-product', raw?.product_identity || '取得不可');
  setText('#diagnostic-artifact-prototype', raw?.prototype_status || '取得不可');
  setText('#diagnostic-artifact-url', artifactUrl || '取得不可');
  setText('#artifact-sha', digest ? short(digest) : '取得不可');
}

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
  const diagnostic = {
    runtime_version: RUNTIME_VERSION,
    artifact_runtime_version: artifact?.runtime_version || null,
    artifact_schema_version: artifact?.schema_version || null,
    expected_runtime_version: buildInfo?.expected_runtime_version || null,
    expected_runtime_schema: buildInfo?.expected_runtime_schema || null,
    expected_artifact_sha256: buildInfo?.artifact_sha256 || null,
    actual_artifact_sha256: actualSha || null,
  };
  const compatible = Boolean(buildInfo && actualSha)
    && buildInfo.schema_version === 'ride-planning-build-info-v1'
    && buildInfo.expected_runtime_version === RUNTIME_VERSION
    && artifact?.runtime_version === RUNTIME_VERSION
    && buildInfo.expected_runtime_schema === artifact?.schema_version
    && buildInfo.ui_runtime_generation === runtimeGeneration(RUNTIME_VERSION)
    && buildInfo.artifact_sha256 === actualSha;
  const warning = document.querySelector('#cache-warning');
  warning.classList.toggle('hidden', compatible);
  warning.dataset.compatibilityDiagnostic = JSON.stringify(diagnostic);
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (registration.installing) reject(new Error('新しいbundleの取得が完了しませんでした。'));
      else resolve(registration.waiting);
    }, timeout);
    const installing = registration.installing;
    if (!installing) {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') {
        clearTimeout(timer);
        resolve(registration.waiting);
      } else if (installing.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('新しいbundleを完全に取得できませんでした。'));
      }
    });
  });
}

async function workerVersion(worker) {
  const value = await workerMessage(worker, 'GET_VERSION');
  if (!value?.cacheId) throw new Error('Service Workerのbundle識別を確認できません。');
  return value;
}

async function waitForControllerCache(cacheId, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      try {
        const value = await workerVersion(controller);
        if (value.cacheId === cacheId) return controller;
      } catch (error) {
        // The controller may be changing between generations; retry until the deadline.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('新しいbundleへの切替を確認できませんでした。');
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
    let worker = navigator.serviceWorker.controller || registration.active;
    if (waiting) {
      const target = await workerVersion(waiting);
      await workerMessage(waiting, 'ACTIVATE_UPDATE');
      worker = await waitForControllerCache(target.cacheId);
    }
    const current = await workerVersion(worker);
    const verified = await workerMessage(worker, 'VERIFY_ASSETS', 10000);
    if (!verified?.valid || verified.cacheId !== current.cacheId) {
      throw new Error(verified?.error || '最新assetの完全性を確認できませんでした。');
    }
    status.textContent = '最新版を取得しました。再読み込みします…';
    location.reload();
  } catch (error) {
    status.textContent = `更新できませんでした: ${error?.message || '原因不明のエラー'}`;
    button.disabled = false;
  }
}

async function loadArtifact() {
  setText('#runtime-version', RUNTIME_VERSION);
  artifactUrl = new URL('./artifacts/ride_planning_runtime_v1.json', document.baseURI).href;
  renderArtifactDiagnostic('取得中');
  try {
    const response = await fetchWithin('./artifacts/ride_planning_runtime_v1.json', '予測データ');
    artifactUrl = response.url || artifactUrl;
    if (!response.ok) throw new Error(`予測データ取得失敗 (${response.status})`);
    const bytes = await withTimeout(response.arrayBuffer(), 3000, '予測データ読込');
    rawArtifact = JSON.parse(new TextDecoder().decode(bytes));
    try {
      artifactSha256 = await sha256(bytes);
    } catch (error) {
      artifactSha256 = undefined;
    }
    renderArtifactDiagnostic('検証中');
    artifact = validateArtifact(rawArtifact);
    renderArtifactDiagnostic('一致');
    updateAllSubmitStates();
    window.dispatchEvent(new Event('rideplanning:artifact-ready'));
    return artifactSha256 || null;
  } catch (error) {
    artifact = undefined;
    renderArtifactDiagnostic('不一致');
    updateAllSubmitStates();
    const node = document.querySelector('#fatal');
    const diagnostic = error.compatibilityDiagnostic;
    node.dataset.compatibilityDiagnostic = diagnostic ? JSON.stringify(diagnostic) : '';
    const detail = diagnostic
      ? ` 診断: runtime=${diagnostic.runtime_version}, artifact runtime=${diagnostic.artifact_runtime_version}, artifact schema=${diagnostic.artifact_schema_version}`
      : '';
    node.textContent = `${error.message}${detail} 初回利用またはcache消去後は、通信可能な状態で開き直してください。`;
    node.classList.remove('hidden');
    window.dispatchEvent(new CustomEvent('rideplanning:artifact-failed', {
      detail: { message: error.message, compatibilityDiagnostic: diagnostic || null },
    }));
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
      const registration = await navigator.serviceWorker.register(
        './service-worker.js', { updateViaCache: 'none' });
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

const ITINERARY_MODE = 'itinerary';
const MAX_ITINERARY_POINTS = 20;
const MAX_ITINERARY_DISTANCE_KM = 500;

const itineraryFinite = (value, label) => {
  if (value === '' || value === null || value === undefined) throw new Error(`${label}を入力してください。`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}は0以上の数値で指定してください。`);
  return number;
};

function clockText(epochSec, originEpochSec) {
  const date = new Date(epochSec * 1000);
  const origin = new Date(originEpochSec * 1000);
  const startDay = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate()).getTime();
  const day = Math.floor((date.getTime() - startDay) / 86400000);
  const prefix = day === 1 ? '翌日 ' : day > 1 ? `${day}日後 ` : day < 0 ? '前日 ' : '';
  return `${prefix}${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function timeValue(epochSec) {
  const date = new Date(epochSec * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function epochForEditedClock(value, referenceEpochSec) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) throw new Error('時刻を入力してください。');
  const [hour, minute] = value.split(':').map(Number);
  const reference = new Date(referenceEpochSec * 1000);
  const base = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), hour, minute).getTime() / 1000;
  return [base - 86400, base, base + 86400, base + 172800]
    .reduce((best, candidate) => Math.abs(candidate - referenceEpochSec) < Math.abs(best - referenceEpochSec) ? candidate : best);
}

function calculateItinerary(rawPoints, anchor, predictBase, reserveSec = 0) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 2 || rawPoints.length > MAX_ITINERARY_POINTS) {
    throw new Error('行程ポイント数が不正です。');
  }
  const points = rawPoints.map((point, index) => ({
    point_id: String(point.point_id || ''), name: String(point.name || ''),
    planned_event_code: index > 0 && index < rawPoints.length - 1
      ? (point.planned_event_code || null) : null,
    leg_distance_km: index === 0 ? 0 : itineraryFinite(point.leg_distance_km, '区間距離'),
    stay_duration_sec: index > 0 && index < rawPoints.length - 1
      ? itineraryFinite(point.stay_duration_sec, '滞在時間') : 0,
  }));
  if (points.some(point => !point.point_id) || new Set(points.map(point => point.point_id)).size !== points.length) {
    throw new Error('行程ポイントIDが不正です。');
  }
  const anchorIndex = points.findIndex(point => point.point_id === anchor?.point_id);
  const allowedKind = anchorIndex === 0 ? 'departure' : 'arrival';
  if (anchorIndex < 0 || anchor?.kind !== allowedKind || !Number.isFinite(anchor.epoch_sec)) {
    throw new Error('固定時刻が不正です。');
  }
  let cumulative = 0;
  let previous = { moving_time_sec: 0, natural_stop_time_sec: 0 };
  const legs = points.slice(1).map((point, index) => {
    cumulative += point.leg_distance_km;
    if (cumulative > MAX_ITINERARY_DISTANCE_KM) throw new Error('総距離は500km以下で指定してください。');
    const prediction = predictBase(cumulative);
    const leg = {
      from_point_id: points[index].point_id, to_point_id: point.point_id,
      distance_km: point.leg_distance_km,
      moving_time_sec: prediction.moving_time_sec - previous.moving_time_sec,
      natural_stop_time_sec: prediction.natural_stop_time_sec - previous.natural_stop_time_sec,
    };
    leg.travel_time_sec = leg.moving_time_sec + leg.natural_stop_time_sec;
    if (leg.moving_time_sec < -1e-6 || leg.natural_stop_time_sec < -1e-6) throw new Error('区間予測が単調ではありません。');
    previous = prediction;
    return leg;
  });
  const times = points.map(() => ({}));
  if (anchorIndex === 0) times[0].departure_epoch_sec = anchor.epoch_sec;
  else times[anchorIndex].arrival_epoch_sec = anchor.epoch_sec;
  for (let index = anchorIndex; index < points.length - 1; index += 1) {
    const departure = index === 0 ? times[index].departure_epoch_sec
      : times[index].arrival_epoch_sec + points[index].stay_duration_sec;
    times[index].departure_epoch_sec = departure;
    times[index + 1].arrival_epoch_sec = departure + legs[index].travel_time_sec;
  }
  for (let index = anchorIndex; index > 0; index -= 1) {
    const priorDeparture = times[index].arrival_epoch_sec - legs[index - 1].travel_time_sec;
    times[index - 1].departure_epoch_sec = priorDeparture;
    if (index - 1 > 0) times[index - 1].arrival_epoch_sec = priorDeparture - points[index - 1].stay_duration_sec;
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    times[index].departure_epoch_sec = times[index].arrival_epoch_sec + points[index].stay_duration_sec;
  }
  times[points.length - 1].arrival_epoch_sec += itineraryFinite(reserveSec, '予備時間');
  if (anchorIndex === points.length - 1) {
    times[points.length - 1].arrival_epoch_sec = anchor.epoch_sec;
    let arrival = anchor.epoch_sec - itineraryFinite(reserveSec, '予備時間');
    for (let index = points.length - 1; index > 0; index -= 1) {
      const priorDeparture = arrival - legs[index - 1].travel_time_sec;
      times[index - 1].departure_epoch_sec = priorDeparture;
      if (index - 1 > 0) {
        times[index - 1].arrival_epoch_sec = priorDeparture - points[index - 1].stay_duration_sec;
        times[index - 1].departure_epoch_sec = priorDeparture;
        arrival = times[index - 1].arrival_epoch_sec;
      }
    }
  }
  return {
    points: points.map((point, index) => ({ ...point, ...times[index] })), legs,
    total_distance_km: cumulative,
    planned_event_time_sec: points.reduce((sum, point) => sum + point.stay_duration_sec, 0),
    moving_time_sec: previous.moving_time_sec,
    natural_stop_time_sec: previous.natural_stop_time_sec,
    departure_epoch_sec: times[0].departure_epoch_sec,
    arrival_epoch_sec: times[points.length - 1].arrival_epoch_sec,
  };
}

const SIMPLE_MODEL_ID = 'simple-origin-linear-v2';
const SIMPLE_SETTINGS_KEY = 'ride-planning-lab-simple-model-settings-v2';
const LEGACY_SIMPLE_SETTINGS_KEY = 'ride-planning-lab-simple-model-settings-v1';
const SIMPLE_DEFAULTS = Object.freeze({
  speed_kmh: 17,
  early_width_at_100km_min: 40,
  late_width_at_100km_min: 50,
});
const LEGACY_DEFAULTS = Object.freeze({
  speed_kmh: 16, p10_fixed_min: 10, p10_per_km_min: 0.30,
  p90_fixed_min: 30, p90_per_km_min: 0.20,
});

function finite(value, name, positive = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number === 0)) {
    throw new Error(`${name}は${positive ? '0より大きい' : '0以上の'}数値で指定してください。`);
  }
  return number;
}

function validateSimpleSettings(raw) {
  const value = {
    speed_kmh: finite(raw?.speed_kmh, '基準速度', true),
    early_width_at_100km_min: finite(raw?.early_width_at_100km_min, '100km時の早め幅'),
    late_width_at_100km_min: finite(raw?.late_width_at_100km_min, '100km時の遅め幅'),
  };
  if (60 / value.speed_kmh <= value.early_width_at_100km_min / 100) {
    throw new Error('早め予測が距離とともに増えるよう、100km時の早め幅を小さくしてください。');
  }
  return value;
}

function migrateSimpleSettings(raw) {
  if (raw?.early_width_at_100km_min !== undefined || raw?.late_width_at_100km_min !== undefined) {
    return validateSimpleSettings(raw);
  }
  const legacy = Object.fromEntries(Object.keys(LEGACY_DEFAULTS).map(key => [key, finite(raw?.[key], key)]));
  if (Object.keys(LEGACY_DEFAULTS).every(key => legacy[key] === LEGACY_DEFAULTS[key])) {
    return { ...SIMPLE_DEFAULTS };
  }
  return validateSimpleSettings({
    speed_kmh: legacy.speed_kmh,
    early_width_at_100km_min: legacy.p10_fixed_min + 100 * legacy.p10_per_km_min,
    late_width_at_100km_min: legacy.p90_fixed_min + 100 * legacy.p90_per_km_min,
  });
}

function loadSimpleSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SIMPLE_SETTINGS_KEY);
    if (raw) return validateSimpleSettings(JSON.parse(raw));
    const legacy = storage?.getItem(LEGACY_SIMPLE_SETTINGS_KEY);
    if (!legacy) return { ...SIMPLE_DEFAULTS };
    const migrated = migrateSimpleSettings(JSON.parse(legacy));
    storage?.setItem(SIMPLE_SETTINGS_KEY, JSON.stringify(migrated));
    return migrated;
  } catch (error) {
    return { ...SIMPLE_DEFAULTS };
  }
}

function saveSimpleSettings(settings, storage = globalThis.localStorage) {
  const value = validateSimpleSettings(settings);
  storage?.setItem(SIMPLE_SETTINGS_KEY, JSON.stringify(value));
  return value;
}

function resetSimpleSettings(storage = globalThis.localStorage) {
  storage?.removeItem(SIMPLE_SETTINGS_KEY);
  storage?.removeItem(LEGACY_SIMPLE_SETTINGS_KEY);
  return { ...SIMPLE_DEFAULTS };
}

function plannedSeconds(eventMinutes) {
  if (!Array.isArray(eventMinutes)) throw new Error('予定イベントが不正です。');
  return eventMinutes.reduce((sum, value) => sum + finite(value, '予定イベント時間') * 60, 0);
}

function simpleBaseMinutes(distanceKm, settings) {
  const distance = finite(distanceKm, '往復距離');
  const value = validateSimpleSettings(settings);
  const center = distance / value.speed_kmh * 60;
  const earlyWidth = value.early_width_at_100km_min * distance / 100;
  const lateWidth = value.late_width_at_100km_min * distance / 100;
  return {
    center,
    p10: Math.max(0, center - earlyWidth),
    p90: center + lateWidth,
  };
}

function estimateSimpleDestination(input, settings) {
  const distance = finite(input.distance_km, '往復距離');
  const departure = finite(input.departure_epoch_sec, '出発日時');
  const planned = plannedSeconds(input.event_minutes || []);
  const unexpected = finite(input.unexpected_buffer_minutes ?? 0, '予備時間') * 60;
  const base = simpleBaseMinutes(distance, settings);
  const addition = planned + unexpected;
  const elapsed = base.center * 60 + addition;
  const lower = base.p10 * 60 + addition;
  const upper = base.p90 * 60 + addition;
  const warnings = ['simple_prediction_trial', 'component_interval_not_safety_guarantee'];
  if (distance >= 150) warnings.push('residual_ols_long_distance_low_evidence');
  return {
    prediction_model: SIMPLE_MODEL_ID,
    distance_km: distance,
    moving_time_sec: base.center * 60,
    natural_stop_time_sec: 0,
    unexpected_buffer_sec: unexpected,
    planned_event_time_sec: planned,
    residual_nonmoving_time_sec: unexpected,
    elapsed_time_sec: elapsed,
    elapsed_lower_sec: lower,
    elapsed_upper_sec: upper,
    arrival_at: departure + elapsed,
    arrival_lower_at: departure + lower,
    arrival_upper_at: departure + upper,
    warnings,
    interval_band: 'simple_distance_formula',
    interval_sample_count: 155,
    interval_fallback_source: 'fixed_personal_trial_formula',
  };
}

function scenarioMinutes(distance, quantile, planned, unexpected, settings) {
  const base = simpleBaseMinutes(distance, settings);
  return base[quantile] + planned + unexpected;
}

function solveDistance(budgetMinutes, quantile, planned, unexpected, settings) {
  if (scenarioMinutes(0, quantile, planned, unexpected, settings) > budgetMinutes) return 0;
  let low = 0;
  let high = 500;
  if (scenarioMinutes(high, quantile, planned, unexpected, settings) <= budgetMinutes) {
    throw new Error('簡易モデルの距離探索上限を超えました。');
  }
  for (let index = 0; index < 80 && high - low > 0.001; index += 1) {
    const middle = (low + high) / 2;
    if (scenarioMinutes(middle, quantile, planned, unexpected, settings) <= budgetMinutes) low = middle;
    else high = middle;
  }
  return low;
}

function estimateSimpleDistance(input, settings) {
  const departure = finite(input.departure_epoch_sec, '出発日時');
  const deadline = finite(input.deadline_epoch_sec, '帰宅期限');
  if (deadline <= departure) throw new Error('帰宅期限は出発時刻より後にしてください。');
  const plannedSec = plannedSeconds(input.event_minutes || []);
  const unexpectedSec = finite(input.unexpected_buffer_minutes ?? 0, '予備時間') * 60;
  const budgetSec = deadline - departure;
  const planned = plannedSec / 60;
  const unexpected = unexpectedSec / 60;
  if (plannedSec + unexpectedSec >= budgetSec) {
    return {
      prediction_model: SIMPLE_MODEL_ID,
      prototype_max_distance_km: 0,
      moving_time_sec: 0,
      natural_stop_time_sec: 0,
      unexpected_buffer_sec: unexpectedSec,
      planned_event_time_sec: plannedSec,
      residual_nonmoving_time_sec: unexpectedSec,
      elapsed_time_sec: plannedSec + unexpectedSec,
      warnings: ['simple_prediction_trial'],
      distance_lower_km: 0,
      distance_upper_km: 0,
      available_time_sec: budgetSec,
      moving_lower_sec: 0,
      moving_upper_sec: 0,
      residual_lower_sec: unexpectedSec,
      residual_upper_sec: unexpectedSec,
    };
  }
  const budget = budgetSec / 60;
  const center = solveDistance(budget, 'center', planned, unexpected, settings);
  const lower = Math.min(solveDistance(budget, 'p90', planned, unexpected, settings), center);
  const upper = Math.max(solveDistance(budget, 'p10', planned, unexpected, settings), center);
  const forward = estimateSimpleDestination({
    distance_km: center,
    departure_epoch_sec: departure,
    event_minutes: input.event_minutes || [],
    unexpected_buffer_minutes: unexpected,
  }, settings);
  return {
    prediction_model: SIMPLE_MODEL_ID,
    prototype_max_distance_km: center,
    moving_time_sec: forward.moving_time_sec,
    natural_stop_time_sec: 0,
    unexpected_buffer_sec: unexpectedSec,
    planned_event_time_sec: plannedSec,
    residual_nonmoving_time_sec: unexpectedSec,
    elapsed_time_sec: forward.elapsed_time_sec,
    warnings: forward.warnings,
    distance_lower_km: lower,
    distance_upper_km: upper,
    available_time_sec: budgetSec,
    moving_lower_sec: simpleBaseMinutes(lower, settings).center * 60,
    moving_upper_sec: simpleBaseMinutes(upper, settings).center * 60,
    residual_lower_sec: unexpectedSec,
    residual_upper_sec: unexpectedSec,
  };
}

const QUICK_RETURN_DISTANCE_KEY = 'ride-planning-lab-quick-return-distance-v1';
const QUICK_RETURN_BUFFER_KEY = 'ride-planning-lab-quick-return-buffer-minutes-v1';
const QUICK_RETURN_MAX_DISTANCE_KM = 150;
const QUICK_RETURN_MAX_BUFFER_MINUTES = 120;
const QUICK_RETURN_BUFFER_STEP_MINUTES = 10;
const QUICK_RETURN_DEFAULT_DISTANCE_KM = 25;

function nonnegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}は0以上で入力してください。`);
  return number;
}

function estimateQuickReturn(distanceKm, extraMinutes, now, predictionModel, simpleSettings, artifact) {
  const distance = nonnegative(distanceKm, '残距離');
  const extra = nonnegative(extraMinutes, '予定停止・余裕時間');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('現在時刻を取得できません。');
  const input = { distance_km: distance, departure_epoch_sec: now.getTime() / 1000,
    event_minutes: [], unexpected_buffer_minutes: extra };
  const prediction = predictionModel === 'simple'
    ? estimateSimpleDestination(input, simpleSettings)
    : estimateDestination(input, artifact);
  return {
    arrivalAt: new Date(prediction.arrival_at * 1000),
    earlyArrivalAt: new Date(prediction.arrival_lower_at * 1000),
    lateArrivalAt: new Date(prediction.arrival_upper_at * 1000),
    remainingMinutes: prediction.elapsed_time_sec / 60,
    predictionModel,
  };
}

function quickReturnClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function quickReturnDuration(minutes) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return hours ? `${hours}時間${rest}分` : `${rest}分`;
}

function loadDistance(storage) {
  try {
    const raw = storage?.getItem(QUICK_RETURN_DISTANCE_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= QUICK_RETURN_MAX_DISTANCE_KM
      ? value : QUICK_RETURN_DEFAULT_DISTANCE_KM;
  } catch (error) {
    return QUICK_RETURN_DEFAULT_DISTANCE_KM;
  }
}

function loadBufferMinutes(storage) {
  try {
    const raw = storage?.getItem(QUICK_RETURN_BUFFER_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value)
      && value >= 0
      && value <= QUICK_RETURN_MAX_BUFFER_MINUTES
      && value % QUICK_RETURN_BUFFER_STEP_MINUTES === 0
      ? value : 0;
  } catch (error) {
    return 0;
  }
}

function initializeQuickReturn({ now = () => new Date(), storage = globalThis.localStorage,
  model = () => 'simple', settings = () => undefined, artifact = () => undefined } = {}) {
  const form = document.querySelector('#quick-return-form');
  const arrival = document.querySelector('#quick-return-arrival');
  const earlyArrival = document.querySelector('#quick-return-early');
  const lateArrival = document.querySelector('#quick-return-late');
  const remaining = document.querySelector('#quick-return-duration');
  const calculatedAt = document.querySelector('#quick-return-calculated-at');
  const error = document.querySelector('#quick-return-error');
  if (!form || !arrival || !earlyArrival || !lateArrival || !remaining || !calculatedAt || !error) return () => {};
  const distance = form.elements.remaining_distance_km;
  const buffer = form.elements.extra_minutes;
  distance.innerHTML = Array.from(
    { length: QUICK_RETURN_MAX_DISTANCE_KM + 1 },
    (_, value) => `<option value="${value}">${value} km</option>`,
  ).join('');
  buffer.innerHTML = Array.from(
    { length: QUICK_RETURN_MAX_BUFFER_MINUTES / QUICK_RETURN_BUFFER_STEP_MINUTES + 1 },
    (_, index) => {
      const value = index * QUICK_RETURN_BUFFER_STEP_MINUTES;
      return `<option value="${value}">${value}分</option>`;
    },
  ).join('');
  distance.value = String(loadDistance(storage));
  buffer.value = String(loadBufferMinutes(storage));
  const update = () => {
    try {
      if (!form.checkValidity()) throw new Error('残距離と時間を確認してください。');
      const selectedModel = model();
      const currentArtifact = artifact();
      if (selectedModel === 'current' && currentArtifact === undefined) {
        arrival.textContent = '—';
        earlyArrival.textContent = '—';
        lateArrival.textContent = '—';
        remaining.textContent = '残り時間を計算中';
        calculatedAt.textContent = '計算時刻 —';
        error.textContent = '';
        error.classList.add('hidden');
        return;
      }
      const calculationTime = now();
      const result = estimateQuickReturn(
        distance.value,
        buffer.value,
        calculationTime,
        selectedModel,
        settings(),
        currentArtifact,
      );
      try {
        storage?.setItem(QUICK_RETURN_DISTANCE_KEY, distance.value);
        storage?.setItem(QUICK_RETURN_BUFFER_KEY, buffer.value);
      } catch (error) { /* optional */ }
      arrival.textContent = quickReturnClock(result.arrivalAt);
      earlyArrival.textContent = quickReturnClock(result.earlyArrivalAt);
      lateArrival.textContent = quickReturnClock(result.lateArrivalAt);
      remaining.textContent = `残り約${quickReturnDuration(result.remainingMinutes)}`;
      calculatedAt.textContent = `現在 ${quickReturnClock(calculationTime)} 時点`;
      error.textContent = '';
      error.classList.add('hidden');
    } catch (reason) {
      arrival.textContent = '—';
      earlyArrival.textContent = '—';
      lateArrival.textContent = '—';
      remaining.textContent = '残り時間を計算できません';
      calculatedAt.textContent = '計算時刻 —';
      error.textContent = reason.message;
      error.classList.remove('hidden');
    }
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') update();
  });
  window.addEventListener('rideplanning:artifact-ready', update);
  window.addEventListener('rideplanning:artifact-failed', event => {
    arrival.textContent = '—';
    earlyArrival.textContent = '—';
    lateArrival.textContent = '—';
    remaining.textContent = '残り時間を計算できません';
    calculatedAt.textContent = '計算時刻 —';
    error.textContent = event.detail?.message || '予測データを利用できません。';
    error.classList.remove('hidden');
  });
  update();
  return update;
}

const currentCalculations = { destination: null, distance: null };
const snapshotNameDrafts = { destination: '', distance: '' };
const MODEL_SELECTION_STORAGE_KEY = 'ride-planning-lab-prediction-model-v1';
const DEFAULT_PREDICTION_MODEL = 'simple';

function loadPredictionModel(storage = globalThis.localStorage) {
  try {
    const value = storage.getItem(MODEL_SELECTION_STORAGE_KEY);
    return value === 'current' || value === 'simple' ? value : DEFAULT_PREDICTION_MODEL;
  } catch (error) {
    return DEFAULT_PREDICTION_MODEL;
  }
}

function savePredictionModel(value, storage = globalThis.localStorage) {
  const selected = value === 'current' || value === 'simple' ? value : DEFAULT_PREDICTION_MODEL;
  try {
    storage.setItem(MODEL_SELECTION_STORAGE_KEY, selected);
  } catch (error) {
    // Keep the in-memory selection usable when device storage is unavailable.
  }
  return selected;
}

let ridePlanUi;
let predictionModel = loadPredictionModel();
let simpleSettings = loadSimpleSettings();
let inputMode = 'simple';
const pointUuid = () => globalThis.crypto.randomUUID();
let itineraryState = {
  points: [
    { point_id: pointUuid(), name: '', leg_distance_km: 0, stay_duration_sec: 0, planned_event_code: null },
    { point_id: pointUuid(), name: '', leg_distance_km: 140, stay_duration_sec: 0, planned_event_code: null },
  ],
  anchor: { point_id: null, kind: 'departure', epoch_sec: epoch('08:00') },
};
let lastItineraryAggregate = null;
itineraryState.anchor.point_id = itineraryState.points[0].point_id;

function selectedModelIsSimple() {
  return predictionModel === 'simple';
}

function clearResults() {
  currentCalculations.destination = null;
  currentCalculations.distance = null;
  document.querySelector('#destination-result').innerHTML = '';
  document.querySelector('#distance-result').innerHTML = '';
  ridePlanUi?.refreshSaveControls();
}

function rememberSnapshotName(node, mode) {
  const field = node.querySelector('[data-snapshot-name]');
  if (field) snapshotNameDrafts[mode] = field.value;
}

function revealCalculation(node, html, mode) {
  reveal(node, html);
  const field = node.querySelector('[data-snapshot-name]');
  if (field) field.value = snapshotNameDrafts[mode];
  ridePlanUi?.refreshSaveControls();
}

function updateCalculation(node, html, mode, shouldReveal = false) {
  if (shouldReveal) revealCalculation(node, html, mode);
  else {
    node.innerHTML = html;
    const field = node.querySelector('[data-snapshot-name]');
    if (field) field.value = snapshotNameDrafts[mode];
    ridePlanUi?.refreshSaveControls();
  }
}

function setSnapshotNameDraft(mode, value) {
  snapshotNameDrafts[mode] = value;
  const field = document.querySelector(`#${mode}-result [data-snapshot-name]`);
  if (field) field.value = value;
}

function modelInput() {
  return selectedModelIsSimple()
    ? { prediction_model: 'simple', simple_model_id: SIMPLE_MODEL_ID,
        simple_model_parameters: { ...simpleSettings } }
    : { prediction_model: 'current' };
}

function modelReproduction() {
  const value = { ...reproduction(), prediction_model: predictionModel };
  if (selectedModelIsSimple()) {
    value.simple_model_id = SIMPLE_MODEL_ID;
    value.simple_model_parameters = { ...simpleSettings };
  }
  return value;
}

function destinationCalculation(result, distance, departureEpoch, events, reserveMinutes) {
  return {
    reproduction: modelReproduction(),
    calculation: {
      mode: 'distance_to_time',
      input: {
        distance_km: distance,
        departure_epoch_sec: departureEpoch,
        planned_events: events.map(({ minutes, ...event }) => event),
        reserve_time_sec: reserveMinutes * 60,
        ...modelInput(),
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

function basePrediction(distance) {
  const input = { distance_km: distance, departure_epoch_sec: 0,
    event_minutes: [], unexpected_buffer_minutes: 0 };
  const result = selectedModelIsSimple()
    ? estimateSimpleDestination(input, simpleSettings)
    : estimateDestination(input, getArtifact());
  return { moving_time_sec: result.moving_time_sec,
    natural_stop_time_sec: result.natural_stop_time_sec };
}

function itineraryEvents(points) {
  return points.slice(1, -1).map((point, index) => ({
    event_code: point.point_id, event_type: 'other', role: index === 0 ? 'primary' : 'secondary',
    display_name: point.name.trim() || `ポイント${index + 1}`, route_order: index,
    planned_event_type_code: point.planned_event_code || null,
    planned_duration_sec: point.stay_duration_sec,
  }));
}


function pickerOptions(start, end, selected, format = value => String(value)) {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const value = start + offset;
    return `<option value="${value}"${value === selected ? ' selected' : ''}>${format(value)}</option>`;
  }).join('');
}

function distancePicker(point) {
  const value = Number(point.leg_distance_km || 0);
  const whole = Math.min(500, Math.floor(value));
  const tenth = whole === 500 ? 0 : Math.round((value - whole) * 10);
  return `<div class="itinerary-picker distance-picker"><select data-point-field="distance_whole" data-target-point-id="${point.point_id}" aria-label="区間距離 km">${pickerOptions(0, 500, whole, item => `${item} km`)}</select><select data-point-field="distance_tenth" data-target-point-id="${point.point_id}" aria-label="区間距離 小数">${pickerOptions(0, 9, tenth, item => `.${item}`)}</select></div>`;
}

function stayPicker(point) {
  const minutes = Math.max(0, Math.round(Number(point.stay_duration_sec || 0) / 60));
  const hours = Math.min(24, Math.floor(minutes / 60));
  const remainder = hours === 24 ? 0 : minutes % 60;
  return `<div class="itinerary-picker stay-picker"><select data-point-field="stay_hours" aria-label="滞在時間 時間">${pickerOptions(0, 24, hours, item => `${item}時間`)}</select><select data-point-field="stay_minutes" aria-label="滞在時間 分">${pickerOptions(0, 59, remainder, item => `${item}分`)}</select></div>`;
}

function eventTypePicker(point) {
  const options = plannedEventTypes.map(item => `<option value="${item.event_code}"${item.event_code === point.planned_event_code ? ' selected' : ''}>${item.label}</option>`).join('');
  return `<select data-point-field="planned_event_code" aria-label="滞在種別"><option value=""${point.planned_event_code ? '' : ' selected'}>未指定</option>${options}</select>`;
}

function itinerarySnapshot(result, aggregate, reserveMinutes) {
  const events = itineraryEvents(aggregate.points);
  const context = destinationCalculation(result, aggregate.total_distance_km,
    aggregate.departure_epoch_sec, events.map(event => ({ ...event, minutes: event.planned_duration_sec / 60 })), reserveMinutes);
  context.calculation.input.itinerary = {
    mode: 'itinerary', anchor: { ...itineraryState.anchor },
    points: aggregate.points.map(point => ({ ...point })),
    legs: aggregate.legs.map(leg => ({ ...leg })),
  };
  return context;
}

function renderItinerary(aggregate = null) {
  const root = document.querySelector('#itinerary-points');
  root.innerHTML = itineraryState.points.map((point, index) => {
    const middle = index > 0 && index < itineraryState.points.length - 1;
    const calculated = aggregate?.points[index];
    const nextPoint = itineraryState.points[index + 1];
    const anchor = itineraryState.anchor.point_id === point.point_id;
    const anchorMark = anchor ? '<small class="anchor-mark">指定</small>' : '';
    const arrival = index > 0 ? `<label>到着時刻 ${anchorMark}<input type="time" data-point-time="arrival" data-point-id="${point.point_id}" value="${calculated ? timeValue(calculated.arrival_epoch_sec) : ''}">${calculated ? `<small>${clockText(calculated.arrival_epoch_sec, aggregate.departure_epoch_sec)}</small>` : ''}</label>` : '';
    const departure = index === 0
      ? `<label>出発時刻 ${anchorMark}<input type="time" data-point-time="departure" data-point-id="${point.point_id}" value="${calculated ? timeValue(calculated.departure_epoch_sec) : timeValue(itineraryState.anchor.epoch_sec)}"></label>`
      : middle ? `<label>出発時刻<div class="itinerary-clock">${calculated ? clockText(calculated.departure_epoch_sec, aggregate.departure_epoch_sec) : '—'}</div></label>` : '';
    return `<article class="itinerary-point" data-point-id="${point.point_id}">${middle ? `<div class="itinerary-name-row"><input maxlength="60" aria-label="店名・地点名（任意）" data-point-field="name" value="${escapeHtml(point.name)}" placeholder="店名・地点名（任意）"><button type="button" class="itinerary-remove" data-remove-point="${point.point_id}">削除</button></div>` : `<strong class="endpoint-label">${index === 0 ? '出発' : '到着'}</strong>`}
      <div class="itinerary-times">${arrival}${middle ? `<label>滞在種別${eventTypePicker(point)}</label><label>滞在時間${stayPicker(point)}</label>` : ''}${departure}</div>
      ${nextPoint ? `<div class="itinerary-leg"><label>次の地点までの区間距離${distancePicker(nextPoint)}</label><span>↓</span></div>` : ''}</article>`;
  }).join('');
  document.querySelector('#add-itinerary-point').disabled = itineraryState.points.length >= MAX_ITINERARY_POINTS;
}

function recalculateItinerary(shouldReveal = false) {
  const status = document.querySelector('#itinerary-status');
  currentCalculations.destination = null;
  try {
    const reserveMinutes = unexpectedMinutes(document.querySelector('#itinerary-form'));
    const aggregate = calculateItinerary(itineraryState.points, itineraryState.anchor,
      basePrediction, reserveMinutes * 60);
    lastItineraryAggregate = aggregate;
    const events = itineraryEvents(aggregate.points);
    const predictionInput = { distance_km: aggregate.total_distance_km,
      departure_epoch_sec: aggregate.departure_epoch_sec,
      event_minutes: events.map(event => event.planned_duration_sec / 60),
      unexpected_buffer_minutes: reserveMinutes };
    const result = selectedModelIsSimple()
      ? estimateSimpleDestination(predictionInput, simpleSettings)
      : estimateDestination(predictionInput, getArtifact());
    currentCalculations.destination = itinerarySnapshot(result, aggregate, reserveMinutes);
    document.querySelector('#itinerary-total-distance').textContent = `${aggregate.total_distance_km.toFixed(1)} km`;
    document.querySelector('#itinerary-total-planned').textContent = `${Math.round(aggregate.planned_event_time_sec / 60)}分`;
    status.textContent = '';
    renderItinerary(aggregate);
    updateCalculation(document.querySelector('#destination-result'), renderDestinationResult(result, {
      departure_time: clockText(aggregate.departure_epoch_sec, aggregate.departure_epoch_sec),
      epoch: aggregate.departure_epoch_sec,
    }), 'destination', shouldReveal);
  } catch (error) {
    lastItineraryAggregate = null;
    renderItinerary();
    document.querySelector('#itinerary-total-distance').textContent = '—';
    document.querySelector('#itinerary-total-planned').textContent = '—';
    status.textContent = `入力を完成すると計算できます: ${error.message}`;
    document.querySelector('#destination-result').innerHTML = '';
    ridePlanUi?.refreshSaveControls();
  }
}

function setInputMode(mode) {
  inputMode = mode === 'itinerary' ? 'itinerary' : 'simple';
  document.querySelector('#simple-input-panel').classList.toggle('hidden', inputMode !== 'simple');
  document.querySelector('#itinerary-input-panel').classList.toggle('hidden', inputMode !== 'itinerary');
  document.querySelectorAll('[data-input-mode]').forEach(button => button.classList.toggle('active', button.dataset.inputMode === inputMode));
  document.querySelector('#destination-result').innerHTML = '';
  currentCalculations.destination = null;
  if (inputMode === 'itinerary') recalculateItinerary();
  ridePlanUi?.refreshSaveControls();
}

function distanceCalculation(result, departureEpoch, deadlineEpoch, events, reserveMinutes) {
  return {
    reproduction: modelReproduction(),
    calculation: {
      mode: 'time_to_distance',
      input: {
        departure_epoch_sec: departureEpoch,
        return_deadline_epoch_sec: deadlineEpoch,
        available_time_sec: result.available_time_sec,
        planned_events: events.map(({ minutes, ...event }) => event),
        reserve_time_sec: reserveMinutes * 60,
        ...modelInput(),
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
    const input = {
      distance_km: distance,
      departure_epoch_sec: departureEpoch,
      event_minutes: events.map(item => item.minutes),
      unexpected_buffer_minutes: reserveMinutes,
    };
    const result = selectedModelIsSimple()
      ? estimateSimpleDestination(input, simpleSettings)
      : estimateDestination(input, getArtifact());
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
    const input = {
      departure_epoch_sec: departureEpoch,
      deadline_epoch_sec: deadlineEpoch,
      event_minutes: events.map(item => item.minutes),
      unexpected_buffer_minutes: reserveMinutes,
    };
    const result = selectedModelIsSimple()
      ? estimateSimpleDistance(input, simpleSettings)
      : estimateDistance(input, getArtifact());
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

document.querySelectorAll('[data-input-mode]').forEach(button => {
  button.addEventListener('click', () => setInputMode(button.dataset.inputMode));
});
document.querySelector('#add-itinerary-point').addEventListener('click', () => {
  if (itineraryState.points.length >= MAX_ITINERARY_POINTS) return;
  itineraryState.points.splice(-1, 0, {
    point_id: pointUuid(), name: '', leg_distance_km: 0, stay_duration_sec: 0, planned_event_code: null,
  });
  recalculateItinerary();
});
document.querySelector('#itinerary-points').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-point]');
  if (!button) return;
  const removed = itineraryState.points.findIndex(point => point.point_id === button.dataset.removePoint);
  if (removed <= 0 || removed >= itineraryState.points.length - 1) return;
  if (itineraryState.anchor.point_id === button.dataset.removePoint) {
    itineraryState.anchor = { point_id: itineraryState.points[0].point_id,
      kind: 'departure', epoch_sec: itineraryState.anchor.epoch_sec };
  }
  itineraryState.points.splice(removed, 1);
  recalculateItinerary();
});
document.querySelector('#itinerary-form').addEventListener('change', event => {
  const card = event.target.closest('[data-point-id]');
  if (card && event.target.dataset.pointField) {
    const point = itineraryState.points.find(item => item.point_id === (event.target.dataset.targetPointId || card.dataset.pointId));
    const field = event.target.dataset.pointField;
    if (field === 'name') point.name = event.target.value;
    else if (field === 'planned_event_code') point.planned_event_code = event.target.value || null;
    else if (field === 'distance_whole' || field === 'distance_tenth') {
      const picker = event.target.closest('.distance-picker');
      const whole = Number(picker.querySelector('[data-point-field=distance_whole]').value);
      const tenth = whole === 500 ? 0 : Number(picker.querySelector('[data-point-field=distance_tenth]').value);
      point.leg_distance_km = whole + tenth / 10;
    } else if (field === 'stay_hours' || field === 'stay_minutes') {
      const hours = Number(card.querySelector('[data-point-field=stay_hours]').value);
      const minutes = hours === 24 ? 0 : Number(card.querySelector('[data-point-field=stay_minutes]').value);
      point.stay_duration_sec = (hours * 60 + minutes) * 60;
    }
    else point[field] = event.target.value === '' ? '' : Number(event.target.value);
  }
  if (event.target.dataset.pointTime) {
    const point = lastItineraryAggregate?.points.find(item => item.point_id === event.target.dataset.pointId);
    const reference = point?.[`${event.target.dataset.pointTime}_epoch_sec`]
      ?? itineraryState.anchor.epoch_sec;
    itineraryState.anchor = { point_id: event.target.dataset.pointId,
      kind: event.target.dataset.pointTime,
      epoch_sec: epochForEditedClock(event.target.value, reference) };
  }
  recalculateItinerary();
});
document.querySelector('#itinerary-form').addEventListener('submit', event => {
  event.preventDefault();
  rememberSnapshotName(document.querySelector('#destination-result'), 'destination');
  recalculateItinerary(true);
});
document.addEventListener('rideplanning:load-itinerary', event => {
  const saved = event.detail;
  itineraryState = {
    points: saved.points.map(point => ({ ...point })),
    anchor: { ...saved.anchor },
  };
  setInputMode('itinerary');
});

initializeInputs(getArtifact);
ridePlanUi = initializeSnapshotUi(currentCalculations, reproduction, setSnapshotNameDraft);
renderItinerary();
initializeUpdateManager();
const recalculateQuickReturn = initializeQuickReturn({
  model: () => predictionModel,
  settings: () => simpleSettings,
  artifact: getArtifact,
});

function showSection(name) {
  const calculation = name === 'destination' || name === 'distance';
  document.querySelector('#calculator-section').classList.toggle('hidden', !calculation);
  document.querySelector('#destination-view').classList.toggle('hidden', name !== 'destination');
  document.querySelector('#distance-view').classList.toggle('hidden', name !== 'distance');
  ['quick-return', 'settings', 'graph'].forEach(section => {
    document.querySelector(`#${section}-section`).classList.toggle('hidden', section !== name);
  });
  document.querySelectorAll('.primary-nav button').forEach(button => {
    button.classList.toggle('active', button.dataset.section === name);
  });
  document.querySelectorAll('.model-tools button').forEach(button => {
    button.classList.toggle('active', button.dataset.section === name);
  });
  if (name === 'quick-return') recalculateQuickReturn();
  if (name === 'graph') drawModelGraph();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-section]').forEach(button => {
  button.addEventListener('click', () => showSection(button.dataset.section));
});

const modelSelector = document.querySelector('#prediction-model');
function applyPredictionModel(value) {
  predictionModel = value === 'current' || value === 'simple' ? value : DEFAULT_PREDICTION_MODEL;
  modelSelector.value = predictionModel;
  document.querySelector('#model-selection-note').textContent = selectedModelIsSimple()
    ? '保存済み設定の簡易モデルを使用します。暫定比較用です。'
    : '現行モデルを使用します。';
  clearResults();
  recalculateQuickReturn();
  if (inputMode === 'itinerary') recalculateItinerary();
}

applyPredictionModel(predictionModel);
modelSelector.addEventListener('change', () => {
  applyPredictionModel(savePredictionModel(modelSelector.value));
});

const settingsForm = document.querySelector('#simple-settings-form');
function fillSettingsForm(settings) {
  Object.entries(settings).forEach(([name, value]) => { settingsForm.elements[name].value = value; });
}
fillSettingsForm(simpleSettings);

function settingsFromForm() {
  return validateSimpleSettings(Object.fromEntries(new FormData(settingsForm)));
}

settingsForm.addEventListener('input', () => {
  const status = document.querySelector('#settings-status');
  try {
    if (!settingsForm.checkValidity()) throw new Error('すべての設定値を確認してください。');
    simpleSettings = saveSimpleSettings(settingsFromForm());
    status.textContent = 'この端末に保存しました。';
    clearResults();
    drawModelGraph();
    recalculateQuickReturn();
    if (inputMode === 'itinerary') recalculateItinerary();
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector('#reset-simple-settings').addEventListener('click', () => {
  simpleSettings = resetSimpleSettings();
  fillSettingsForm(simpleSettings);
  document.querySelector('#settings-status').textContent = '初期値へ戻しました。';
  clearResults();
  drawModelGraph();
  recalculateQuickReturn();
  if (inputMode === 'itinerary') recalculateItinerary();
});

document.addEventListener('rideplanning:load-model', event => {
  const detail = event.detail || {};
  if (detail.prediction_model === 'simple') {
    simpleSettings = saveSimpleSettings(migrateSimpleSettings(detail.simple_model_parameters));
    fillSettingsForm(simpleSettings);
    applyPredictionModel('simple');
  } else {
    applyPredictionModel('current');
  }
});

function currentGraphMinutes(distance, artifact) {
  const value = estimateDestination({
    distance_km: distance,
    departure_epoch_sec: 0,
    event_minutes: [],
    unexpected_buffer_minutes: 0,
  }, artifact);
  return [value.elapsed_time_sec, value.elapsed_lower_sec, value.elapsed_upper_sec].map(seconds => seconds / 60);
}

function graphSeries(minimum, maximum, artifact) {
  const count = 150;
  const values = [];
  for (let index = 0; index <= count; index += 1) {
    const distance = minimum + (maximum - minimum) * index / count;
    const current = currentGraphMinutes(distance, artifact);
    const simple = simpleBaseMinutes(distance, simpleSettings);
    values.push({ distance, current, simple: [simple.center, simple.p10, simple.p90] });
  }
  return values;
}

function drawLine(context, points, color, dashed) {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  context.setLineDash(dashed ? [8, 5] : []);
  context.beginPath();
  points.forEach(([x, y], index) => { if (index) context.lineTo(x, y); else context.moveTo(x, y); });
  context.stroke();
  context.restore();
}

function drawModelGraph() {
  const status = document.querySelector('#graph-status');
  const canvas = document.querySelector('#model-chart');
  const artifact = getArtifact();
  const minimum = Number(document.querySelector('#graph-min-km').value);
  const maximum = Number(document.querySelector('#graph-max-km').value);
  if (!artifact) { status.textContent = '現行モデルの読込完了後に表示します。'; return; }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum <= minimum || maximum > 500) {
    status.textContent = '距離範囲は0〜500kmで、終了を開始より大きくしてください。';
    return;
  }
  status.textContent = '';
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(280, canvas.parentElement.clientWidth);
  const height = Math.max(260, Math.min(430, width * 0.62));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const margin = { left: 50, right: 14, top: 16, bottom: 38 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const rows = graphSeries(minimum, maximum, artifact);
  const yMaximum = Math.max(...rows.flatMap(row => [...row.current, ...row.simple])) * 1.06;
  const x = distance => margin.left + (distance - minimum) / (maximum - minimum) * plotWidth;
  const y = minutes => margin.top + (yMaximum - minutes) / yMaximum * plotHeight;
  context.font = '12px -apple-system, sans-serif';
  context.fillStyle = '#5b6861';
  context.strokeStyle = '#d7dfd9';
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const minutes = yMaximum * index / 4;
    const yy = y(minutes);
    context.beginPath(); context.moveTo(margin.left, yy); context.lineTo(width - margin.right, yy); context.stroke();
    context.fillText(`${Math.round(minutes)}分`, 4, yy + 4);
  }
  for (let index = 0; index <= 3; index += 1) {
    const distance = minimum + (maximum - minimum) * index / 3;
    context.fillText(`${Math.round(distance)}km`, x(distance) - 14, height - 12);
  }
  const colors = ['#2563b8', '#0d7a4f', '#d86b12'];
  for (let series = 0; series < 3; series += 1) {
    drawLine(context, rows.map(row => [x(row.distance), y(row.current[series])]), colors[series], false);
    drawLine(context, rows.map(row => [x(row.distance), y(row.simple[series])]), colors[series], true);
  }
}

document.querySelectorAll('#graph-min-km,#graph-max-km').forEach(input => input.addEventListener('input', drawModelGraph));
window.addEventListener('resize', () => {
  if (!document.querySelector('#graph-section').classList.contains('hidden')) drawModelGraph();
});
window.addEventListener('rideplanning:artifact-ready', drawModelGraph);
