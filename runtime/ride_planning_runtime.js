export const RUNTIME_VERSION = 'mobile-ride-planning-practical-runtime-v7';
const SCHEMA = 'mobile-ride-planning-runtime-artifact-v5';

function finite(value, name, allowZero = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${name}は0以上の有限な数値で指定してください。`);
  }
  return value;
}

export function validateArtifact(a) {
  if (!a || a.product_identity !== 'ride-planning-lab' ||
      a.schema_version !== SCHEMA || a.runtime_version !== RUNTIME_VERSION ||
      a.prototype_status !== 'personal_use_operational_natural_release') {
    const error = new Error('予測データと計算runtimeのversionが一致しません。オンライン時に更新してください。');
    error.compatibilityDiagnostic = {
      runtime_version: RUNTIME_VERSION,
      artifact_runtime_version: a?.runtime_version || null,
      artifact_schema_version: a?.schema_version || null,
      artifact_product_identity: a?.product_identity || null,
      artifact_prototype_status: a?.prototype_status || null,
    };
    throw error;
  }
  finite(a.moving?.median_sec_per_km, 'moving rate', false);
  const continuousNatural=a.natural?.model==='linear_rate_transition_40_60_then_60_150';
  const pooledNatural=a.natural?.model==='pooled_50plus_rate_with_40_60_smoothing';
  const stepNatural=a.natural?.model==='linear_rate_transition_with_100km_band';
  if (!a.natural || a.natural.episode_cap_sec !== 600 ||
      (!continuousNatural&&!pooledNatural&&!stepNatural) ||
      !Number.isFinite(a.natural.low_sec_per_km)||!Number.isFinite(a.natural.long_sec_per_km)||!Number.isFinite(a.natural.high_sec_per_km)||
      a.natural.low_sec_per_km<0||a.natural.long_sec_per_km<a.natural.low_sec_per_km||a.natural.high_sec_per_km<0||
      !(a.natural.transition_start_km<a.natural.transition_end_km) ||
      (continuousNatural&&(a.natural.high_rate_transition_start_km!==a.natural.transition_end_km ||
      !(a.natural.high_rate_transition_start_km<a.natural.high_rate_transition_end_km))))
    throw new Error('Natural予測データが不正です。');
  finite(a.unexpected?.default_sec,'unexpected default');
  if(a.unexpected.user_editable!==true)throw new Error('予備時間設定が不正です。');
  finite(a.uncertainty?.long_distance_warning_km, 'warning threshold', false);
  if (a.uncertainty?.target!=='moving_plus_natural_only' ||
      a.uncertainty.user_input_uncertainty?.planned_included!==false ||
      a.uncertainty.user_input_uncertainty?.unexpected_included!==false ||
      !Array.isArray(a.uncertainty?.anchors) || a.uncertainty.anchors.length<2 ||
      JSON.stringify(a.uncertainty.quantile_levels) !== '[0.1,0.9]') throw new Error('予測幅データが不正です。');
  let previous=-Infinity;
  a.uncertainty.anchors.forEach(b => {
    if (!Number.isFinite(b.distance_km)||b.distance_km<=previous||!Number.isInteger(b.sample_count)||b.sample_count<0||
        !Number.isFinite(b.p10_sec)||!Number.isFinite(b.p90_sec)||b.p10_sec>b.p90_sec)
      throw new Error('予測幅データが不正です。');
    previous=b.distance_km;
  });
  finite(a.solver?.upper_bound_km, 'solve bound', false);
  finite(a.solver?.tolerance_km, 'solve tolerance', false);
  if (!Number.isInteger(a.solver.maximum_iterations) || a.solver.maximum_iterations <= 0) throw new Error('solver設定が不正です。');
  return a;
}

function plannedSeconds(eventMinutes) {
  if (!Array.isArray(eventMinutes)) throw new Error('予定イベントが不正です。');
  return eventMinutes.reduce((sum, value) => sum + finite(value, '予定イベント時間') * 60, 0);
}

function naturalStop(distance,artifact){
  const n=artifact.natural,start=n.transition_start_km,end=n.transition_end_km;
  let rate;
  if(distance<=start)rate=n.low_sec_per_km;
  else if(distance<end)rate=n.low_sec_per_km+(n.long_sec_per_km-n.low_sec_per_km)*(distance-start)/(end-start);
  else if(n.model==='linear_rate_transition_40_60_then_60_150'&&distance<n.high_rate_transition_end_km){const weight=(distance-n.high_rate_transition_start_km)/(n.high_rate_transition_end_km-n.high_rate_transition_start_km);rate=n.long_sec_per_km+(n.high_sec_per_km-n.long_sec_per_km)*weight}
  else if(n.model==='linear_rate_transition_with_100km_band'&&distance<100)rate=n.long_sec_per_km;
  else rate=n.high_sec_per_km;
  return distance*rate;
}

function unexpectedSeconds(input,artifact){
  const minutes=input.unexpected_buffer_minutes===undefined?artifact.unexpected.default_sec/60:finite(input.unexpected_buffer_minutes,'予備時間');
  return minutes*60;
}

function intervalOffsets(distance,artifact){
  const anchors=artifact.uncertainty.anchors;let left,right;
  if(distance<=anchors[0].distance_km){const weight=Math.max(0,distance/anchors[0].distance_km),value=anchors[0];return {lower:value.p10_sec*weight,upper:value.p90_sec*weight,sampleCount:value.sample_count,source:value.fallback_source}}
  else if(distance>=anchors[anchors.length-1].distance_km)left=right=anchors[anchors.length-1];
  else{const index=anchors.findIndex(a=>distance<=a.distance_km);left=anchors[index-1];right=anchors[index]}
  const weight=left===right?0:(distance-left.distance_km)/(right.distance_km-left.distance_km);
  return {lower:left.p10_sec+weight*(right.p10_sec-left.p10_sec),upper:left.p90_sec+weight*(right.p90_sec-left.p90_sec),
    sampleCount:Math.min(left.sample_count,right.sample_count),source:left.fallback_source===right.fallback_source?left.fallback_source:`${left.fallback_source}_to_${right.fallback_source}`};
}

function interval(distance, unexpected, artifact) {
  const central = naturalStop(distance,artifact)+unexpected;
  const offsets=intervalOffsets(distance,artifact);
  const lower = distance === 0 ? central : Math.max(0, central + offsets.lower);
  const upper = distance === 0 ? central : Math.max(central, central + offsets.upper);
  const warnings = ['practical_natural_plus_unexpected_applied'];
  if (distance >= artifact.uncertainty.long_distance_warning_km) warnings.push('residual_ols_long_distance_low_evidence');
  warnings.push('component_interval_not_safety_guarantee');
  if (offsets.sampleCount < 30) warnings.push('component_interval_anchor_low_evidence');
  return {lower, central, upper, band:{name:'moving_natural_linear_80',sample_count:offsets.sampleCount,fallback_source:offsets.source},warnings: [...new Set(warnings)]};
}

export function estimateDestination(input, rawArtifact) {
  const artifact = validateArtifact(rawArtifact);
  const distance = finite(input.distance_km, '往復距離');
  const departure = finite(input.departure_epoch_sec, '出発日時');
  const planned = plannedSeconds(input.event_minutes || []);
  const unexpected=unexpectedSeconds(input,artifact);
  const moving = distance * artifact.moving.median_sec_per_km;
  const natural=naturalStop(distance,artifact),residual = interval(distance,unexpected, artifact);
  const elapsedLower = moving + planned + residual.lower;
  const elapsed = moving + planned + residual.central;
  const elapsedUpper = moving + planned + residual.upper;
  return {
    distance_km: distance, moving_time_sec: moving, planned_event_time_sec: planned,
    natural_stop_time_sec:natural,unexpected_buffer_sec:unexpected,
    residual_nonmoving_time_sec: residual.central, elapsed_time_sec: elapsed,
    arrival_at: departure + elapsed, warnings: residual.warnings,
    residual_lower_sec: residual.lower, residual_upper_sec: residual.upper,
    elapsed_lower_sec: elapsedLower, elapsed_upper_sec: elapsedUpper,
    arrival_lower_at: departure + elapsedLower, arrival_upper_at: departure + elapsedUpper,
    interval_band: residual.band.name, interval_sample_count: residual.band.sample_count,
    interval_fallback_source: residual.band.fallback_source
  };
}

function scenarioTotal(distance, planned, unexpected, quantile, artifact) {
  const value = interval(distance, unexpected, artifact);
  const residual = quantile === 'p90' ? value.upper : quantile === 'p10' ? value.lower : value.central;
  return distance * artifact.moving.median_sec_per_km + planned + residual;
}

function solveContinuous(budget, planned, unexpected, quantile, artifact) {
  const s=artifact.solver;
  if(scenarioTotal(0,planned,unexpected,quantile,artifact)>budget)return 0;
  if(scenarioTotal(s.upper_bound_km,planned,unexpected,quantile,artifact)<=budget)throw new Error('prototype uncertainty search bound remains feasible');
  let lo=0,hi=s.upper_bound_km;
  for(let i=0;i<s.maximum_iterations&&hi-lo>s.tolerance_km;i+=1){const mid=(lo+hi)/2;if(scenarioTotal(mid,planned,unexpected,quantile,artifact)<=budget)lo=mid;else hi=mid}
  return lo;
}

export function estimateDistance(input, rawArtifact) {
  const artifact = validateArtifact(rawArtifact);
  const departure = finite(input.departure_epoch_sec, '出発日時');
  const deadline = finite(input.deadline_epoch_sec, '帰宅期限');
  if (deadline <= departure) throw new Error('帰宅期限は出発時刻より後にしてください。');
  const budget = deadline - departure, planned = plannedSeconds(input.event_minutes || []), unexpected=unexpectedSeconds(input,artifact);
  if (planned+unexpected >= budget) return {prototype_max_distance_km:0, moving_time_sec:0,
    natural_stop_time_sec:0,unexpected_buffer_sec:unexpected,planned_event_time_sec:planned,
    residual_nonmoving_time_sec:unexpected, elapsed_time_sec:planned+unexpected,
    warnings:interval(0,unexpected, artifact).warnings, distance_lower_km:0, distance_upper_km:0, available_time_sec:budget,
    moving_lower_sec:0, moving_upper_sec:0, residual_lower_sec:unexpected, residual_upper_sec:unexpected};
  const low=solveContinuous(budget,planned,unexpected,'central',artifact);
  const common={departure_epoch_sec:departure,event_minutes:input.event_minutes||[],unexpected_buffer_minutes:unexpected/60};
  const central = estimateDestination({...common,distance_km:low}, artifact);
  let lower = Math.min(solveContinuous(budget, planned, unexpected, 'p90', artifact), low);
  let upper = Math.max(solveContinuous(budget, planned, unexpected, 'p10', artifact), low);
  const lowerBreakdown = estimateDestination({...common,distance_km:lower}, artifact);
  const upperBreakdown = estimateDestination({...common,distance_km:upper}, artifact);
  return {prototype_max_distance_km:low, moving_time_sec:central.moving_time_sec,
    natural_stop_time_sec:central.natural_stop_time_sec,unexpected_buffer_sec:unexpected,
    planned_event_time_sec:planned, residual_nonmoving_time_sec:central.residual_nonmoving_time_sec,
    elapsed_time_sec:central.elapsed_time_sec, warnings:central.warnings,
    distance_lower_km:lower, distance_upper_km:upper, available_time_sec:budget,
    moving_lower_sec:lowerBreakdown.moving_time_sec, moving_upper_sec:upperBreakdown.moving_time_sec,
    residual_lower_sec:upperBreakdown.residual_lower_sec, residual_upper_sec:lowerBreakdown.residual_upper_sec};
}
