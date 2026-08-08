export const APP_VERSION='ride-planning-ui-v25';
export const SNAPSHOT_SCHEMA_VERSION='ride-plan-execution-snapshot-v1';
export const SNAPSHOT_RECORD_TYPE='ride_plan_execution_snapshot';
export const SNAPSHOT_STORE_SCHEMA_VERSION='ride-plan-execution-snapshot-store-v1';
export const SNAPSHOT_STORAGE_KEY='ride-planning-lab-execution-snapshots-v1';
export const CALCULATION_CONTRACT_VERSION='mobile-ride-planning-practical-calculation-v5';

const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function requireFinite(value,label){if(!finite(value))throw new Error(`${label}が不正です。`)}
function requireNonnegative(value,label){requireFinite(value,label);if(value<0)throw new Error(`${label}が不正です。`)}
function validatePredictionModel(input,reproduction){
  const model=input.prediction_model||'current';
  if(!['current','simple'].includes(model))throw new Error('予測モデルが不正です。');
  if(reproduction.prediction_model!==undefined&&reproduction.prediction_model!==model)throw new Error('予測モデルの再現情報が一致しません。');
  if(model==='current')return;
  if(input.simple_model_id!=='simple-distance-rate-trial-v1'||reproduction.simple_model_id!==input.simple_model_id)throw new Error('簡易モデルIDが不正です。');
  const parameters=input.simple_model_parameters;
  const reproduced=reproduction.simple_model_parameters;
  const keys=['speed_kmh','p10_fixed_min','p10_per_km_min','p90_fixed_min','p90_per_km_min'];
  if(!parameters||!reproduced)throw new Error('簡易モデル設定の再現情報がありません。');
  keys.forEach(key=>{requireNonnegative(parameters[key],`簡易モデル ${key}`);if(parameters[key]!==reproduced[key])throw new Error('簡易モデル設定の再現情報が一致しません。')});
  if(parameters.speed_kmh===0||60/parameters.speed_kmh<=parameters.p10_per_km_min)throw new Error('簡易モデル設定が不正です。');
}
export function validateExecutionSnapshot(record){
  if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('Snapshotレコードが不正です。');
  if(record.schema_version!==SNAPSHOT_SCHEMA_VERSION||record.record_type!==SNAPSHOT_RECORD_TYPE)throw new Error('未対応のSnapshot形式です。');
  if(!uuidPattern.test(record.execution_snapshot_id||''))throw new Error('Snapshot IDが不正です。');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.created_at||'')||!Number.isFinite(Date.parse(record.created_at)))throw new Error('作成日時が不正です。');
  if(record.display_name!==undefined&&(typeof record.display_name!=='string'||!record.display_name.trim()||record.display_name.length>80))throw new Error('計画名が不正です。');
  const calculation=record.calculation,input=calculation?.input,result=calculation?.result;
  if(!['distance_to_time','time_to_distance'].includes(calculation?.mode))throw new Error('計算モードが不正です。');
  if(!Array.isArray(input?.planned_events))throw new Error('予定イベントが不正です。');
  input.planned_events.forEach((item,index)=>{if(typeof item?.event_code!=='string'||!item.event_code||!Number.isInteger(item.route_order)||item.route_order!==index||!Number.isInteger(item.planned_duration_sec)||item.planned_duration_sec<0)throw new Error('予定イベントが不正です。')});
  ['departure_epoch_sec','reserve_time_sec'].forEach(key=>requireNonnegative(input[key],key));
  ['standard_elapsed_sec','moving_time_sec','natural_stop_time_sec','planned_event_time_sec','reserve_time_sec'].forEach(key=>requireNonnegative(result?.[key],key));
  if(calculation.mode==='distance_to_time'){
    ['distance_km'].forEach(key=>requireNonnegative(input[key],key));
    ['standard_distance_km','lower_elapsed_sec','upper_elapsed_sec','standard_arrival_epoch_sec','lower_arrival_epoch_sec','upper_arrival_epoch_sec'].forEach(key=>requireNonnegative(result[key],key));
  }else{
    ['return_deadline_epoch_sec','available_time_sec'].forEach(key=>requireNonnegative(input[key],key));
    ['standard_distance_km','lower_distance_km','upper_distance_km'].forEach(key=>requireNonnegative(result[key],key));
  }
  const reproduction=record.reproduction;
  for(const key of ['app_version','runtime_artifact_id','runtime_artifact_sha256','teacher_version','calculation_contract_version'])if(typeof reproduction?.[key]!=='string'||!reproduction[key])throw new Error(`再現情報 ${key} が不正です。`);
  if(!/^[0-9a-f]{64}$/.test(reproduction.runtime_artifact_sha256))throw new Error('Runtime artifact hashが不正です。');
  validatePredictionModel(input,reproduction);
  return record;
}
function readEnvelope(storage){
  const raw=storage.getItem(SNAPSHOT_STORAGE_KEY);
  if(raw===null)return {schema_version:SNAPSHOT_STORE_SCHEMA_VERSION,records:[]};
  let parsed;try{parsed=JSON.parse(raw)}catch(error){throw new Error('保存済みSnapshotを読み取れません。既存データは変更していません。')}
  if(parsed?.schema_version!==SNAPSHOT_STORE_SCHEMA_VERSION||!Array.isArray(parsed.records))throw new Error('保存済みSnapshotの形式が不正です。既存データは変更していません。');
  const ids=new Set();parsed.records.forEach(record=>{validateExecutionSnapshot(record);if(ids.has(record.execution_snapshot_id))throw new Error('保存済みSnapshot IDが重複しています。');ids.add(record.execution_snapshot_id)});
  return parsed;
}
function newUuid(cryptoObject=globalThis.crypto){
  if(cryptoObject?.randomUUID)return cryptoObject.randomUUID();
  if(!cryptoObject?.getRandomValues)throw new Error('このブラウザではSnapshot IDを作成できません。');
  const bytes=cryptoObject.getRandomValues(new Uint8Array(16));bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;
  return [...bytes].map((value,index)=>(index===4||index===6||index===8||index===10?'-':'')+value.toString(16).padStart(2,'0')).join('');
}
export function createExecutionSnapshot(payload,{now=()=>new Date(),cryptoObject=globalThis.crypto}={}){
  const created=now(),name=String(payload.display_name||'').trim();
  const record={schema_version:SNAPSHOT_SCHEMA_VERSION,record_type:SNAPSHOT_RECORD_TYPE,execution_snapshot_id:newUuid(cryptoObject),created_at:created.toISOString(),calculation:clone(payload.calculation),reproduction:clone(payload.reproduction)};
  if(name)record.display_name=name;
  validateExecutionSnapshot(record);return record;
}
export function sameExecutionSnapshotContent(saved,payload){
  if(!saved||!payload)return false;
  return JSON.stringify(canonical({calculation:saved.calculation,reproduction:saved.reproduction}))===JSON.stringify(canonical({calculation:payload.calculation,reproduction:payload.reproduction}));
}
export function loadExecutionSnapshots(storage=globalThis.localStorage){return clone(readEnvelope(storage).records)}
export function appendExecutionSnapshot(record,storage=globalThis.localStorage){
  validateExecutionSnapshot(record);const envelope=readEnvelope(storage);
  if(envelope.records.some(item=>item.execution_snapshot_id===record.execution_snapshot_id))throw new Error('同じSnapshot IDは保存できません。');
  const next={schema_version:SNAPSHOT_STORE_SCHEMA_VERSION,records:[...envelope.records,clone(record)]};
  storage.setItem(SNAPSHOT_STORAGE_KEY,JSON.stringify(next));return clone(record);
}
export function deleteExecutionSnapshot(executionSnapshotId,storage=globalThis.localStorage){
  const envelope=readEnvelope(storage),records=envelope.records.filter(item=>item.execution_snapshot_id!==executionSnapshotId);
  if(records.length===envelope.records.length)throw new Error('削除するSnapshotが見つかりません。');
  storage.setItem(SNAPSHOT_STORAGE_KEY,JSON.stringify({schema_version:SNAPSHOT_STORE_SCHEMA_VERSION,records}));
}
export function deleteAllExecutionSnapshots(storage=globalThis.localStorage){readEnvelope(storage);storage.removeItem(SNAPSHOT_STORAGE_KEY)}
export function executionSnapshotsJsonl(records){return records.map(record=>JSON.stringify(validateExecutionSnapshot(clone(record)))).join('\n')+(records.length?'\n':'')}
export function executionSnapshotsFilename(now=new Date()){return `ride-plan-execution-snapshots-${now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}.jsonl`}
export function importExecutionSnapshotsJsonl(text,storage=globalThis.localStorage){
  if(typeof text!=='string')throw new Error('予測履歴JSONLを読み取れません。既存データは変更していません。');
  const lines=text.split(/\r?\n/).filter(line=>line.trim());
  const incoming=[];
  try{lines.forEach(line=>incoming.push(validateExecutionSnapshot(JSON.parse(line))))}catch(error){throw new Error(`予測履歴JSONLが不正です。既存データは変更していません: ${error.message}`)}
  const envelope=readEnvelope(storage),byId=new Map(envelope.records.map(record=>[record.execution_snapshot_id,record]));
  let imported=0,duplicate=0;
  incoming.forEach(record=>{const existing=byId.get(record.execution_snapshot_id);if(existing){if(JSON.stringify(canonical(existing))!==JSON.stringify(canonical(record)))throw new Error('同じSnapshot IDに異なる内容があります。既存データは変更していません。');duplicate++;return}byId.set(record.execution_snapshot_id,clone(record));imported++});
  storage.setItem(SNAPSHOT_STORAGE_KEY,JSON.stringify({schema_version:SNAPSHOT_STORE_SCHEMA_VERSION,records:[...byId.values()]}));
  return {imported,duplicate,total:byId.size};
}
