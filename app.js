import {RUNTIME_VERSION, estimateDestination, estimateDistance, validateArtifact} from './runtime/ride_planning_runtime.js';
import {APP_VERSION, CALCULATION_CONTRACT_VERSION, appendExecutionSnapshot, createExecutionSnapshot, deleteAllExecutionSnapshots, deleteExecutionSnapshot, executionSnapshotsFilename, executionSnapshotsJsonl, loadExecutionSnapshots, sameExecutionSnapshotContent} from './execution_snapshots.js?v=ride-planning-ui-v16';

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
      <p class="plan-context" data-plan-context>新しい計画</p>
      <button class="secondary" type="button" data-save-plan="${mode}">保存</button>
      <button class="secondary hidden" type="button" data-save-plan-as-new="${mode}">別の計画として保存</button>
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

const RIDE_PLAN_CATALOG_SCHEMA_VERSION = 'ride-plan-catalog-store-v1';
const RIDE_PLAN_CATALOG_STORAGE_KEY = 'ride-planning-lab-ride-plans-v1';
const RIDE_PLAN_CATALOG_EXPORT_SCHEMA_VERSION = 'ride-plan-catalog-export-v1';

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
      const payload = { display_name: title, calculation: context.calculation, reproduction: reproduction() };
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

  document.querySelector('#export-snapshots').addEventListener('click', () => {
    const status = document.querySelector('#snapshot-management-status');
    try {
      const records = loadExecutionSnapshots();
      if (!records.length) {
        status.textContent = '保存した計画がありません。';
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
      status.textContent = `${records.length}件の予測履歴を互換JSONLで出力しました。`;
    } catch (error) {
      status.textContent = `出力できませんでした: ${error.message}`;
    }
  });

  document.querySelector('#import-snapshots').addEventListener('change', async event => {
    const status = document.querySelector('#snapshot-management-status');
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = importExecutionSnapshotsJsonl(await file.text());
      updatePlanCount(`予測履歴を${result.imported}件復元しました（重複${result.duplicate}件）。続けてRidePlan一覧JSONを復元してください。`);
    } catch (error) {
      status.textContent = `予測履歴を復元できませんでした: ${error.message}`;
    } finally {
      event.target.value = '';
    }
  });

  document.querySelector('#export-ride-plan-catalog').addEventListener('click', () => {
    const status = document.querySelector('#snapshot-management-status');
    try {
      const { records, catalog } = loadState();
      if (!catalog.plans.length) {
        status.textContent = '保存した計画がありません。';
        return;
      }
      const url = URL.createObjectURL(new Blob([ridePlanCatalogJson(catalog, records)], {
        type: 'application/json;charset=utf-8',
      }));
      const link = document.createElement('a');
      link.href = url;
      link.download = ridePlanCatalogFilename();
      link.click();
      URL.revokeObjectURL(url);
      status.textContent = `${catalog.plans.length}件のRidePlan一覧を出力しました。予測履歴JSONLも一緒に保管してください。`;
    } catch (error) {
      status.textContent = `RidePlan一覧を出力できませんでした: ${error.message}`;
    }
  });

  document.querySelector('#import-ride-plan-catalog').addEventListener('change', async event => {
    const status = document.querySelector('#snapshot-management-status');
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const records = loadExecutionSnapshots();
      const catalog = importRidePlanCatalogJson(await file.text(), records);
      activeRidePlanId = null;
      updatePlanCount(`${catalog.plans.filter(plan => !plan.deleted_at).length}件のRidePlan一覧を復元しました。`);
      refreshSaveControls();
    } catch (error) {
      status.textContent = `RidePlan一覧を復元できませんでした: ${error.message}`;
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
let ridePlanUi;

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
ridePlanUi = initializeSnapshotUi(currentCalculations, reproduction, setSnapshotNameDraft);
initializeUpdateManager();
