export const RUNTIME_VERSION = 'mobile-ride-planning-portable-runtime-v1';
const SCHEMA = 'mobile-ride-planning-runtime-artifact-v1';

function finite(value, name, allowZero = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${name}は0以上の有限な数値で指定してください。`);
  }
  return value;
}

export function validateArtifact(a) {
  if (!a || a.product_identity !== 'ride-planning-lab' ||
      a.schema_version !== SCHEMA || a.runtime_version !== RUNTIME_VERSION ||
      a.prototype_status !== 'prototype_candidate_not_operational') {
    throw new Error('予測データと計算runtimeのversionが一致しません。オンライン時に更新してください。');
  }
  finite(a.moving?.median_sec_per_km, 'moving rate', false);
  finite(a.residual?.long_distance_warning_km, 'warning threshold', false);
  if (!Number.isFinite(a.residual.intercept_sec) || !Number.isFinite(a.residual.slope_sec_per_km) ||
      a.residual.slope_sec_per_km <= 0 || a.residual.minimum_prediction_sec !== 0 ||
      a.residual.valid_distance_policy !== 'finite_nonnegative_no_product_maximum') throw new Error('予測データが不正です。');
  if (!Array.isArray(a.uncertainty?.bands) || a.uncertainty.bands.length !== 5 ||
      JSON.stringify(a.uncertainty.quantile_levels) !== '[0.1,0.9]') throw new Error('予測幅データが不正です。');
  const expected = [[0,30],[30,60],[60,100],[100,150],[150,null]];
  a.uncertainty.bands.forEach((b, i) => {
    if (b.lower_km !== expected[i][0] || b.upper_km !== expected[i][1] || !Number.isInteger(b.sample_count) ||
        b.sample_count < 10 || !Number.isFinite(b.error_p10_sec) || !Number.isFinite(b.error_p90_sec) ||
        b.error_p10_sec > b.error_p90_sec) throw new Error('予測幅データが不正です。');
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

function bandFor(distance, artifact) {
  return artifact.uncertainty.bands.find(b => distance >= b.lower_km && (b.upper_km === null || distance < b.upper_km));
}

function centralResidual(distance, artifact) {
  const raw = artifact.residual.intercept_sec + artifact.residual.slope_sec_per_km * distance;
  return distance === 0 ? 0 : Math.max(artifact.residual.minimum_prediction_sec, raw);
}

function interval(distance, artifact) {
  const central = centralResidual(distance, artifact);
  const band = bandFor(distance, artifact);
  const lower = distance === 0 ? 0 : Math.max(0, central + band.error_p10_sec);
  const upper = distance === 0 ? 0 : Math.max(central, central + band.error_p90_sec);
  const warnings = ['residual_target_is_not_pure_natural_stop'];
  if (distance >= artifact.residual.long_distance_warning_km) warnings.push('residual_ols_long_distance_low_evidence');
  warnings.push('residual_interval_not_safety_guarantee');
  if (band.sample_count < 30) warnings.push('residual_interval_distance_band_low_evidence');
  return {lower, central, upper, band, warnings: [...new Set(warnings)]};
}

export function estimateDestination(input, rawArtifact) {
  const artifact = validateArtifact(rawArtifact);
  const distance = finite(input.distance_km, '往復距離');
  const departure = finite(input.departure_epoch_sec, '出発日時');
  const planned = plannedSeconds(input.event_minutes || []);
  const moving = distance * artifact.moving.median_sec_per_km;
  const residual = interval(distance, artifact);
  const elapsedLower = moving + planned + residual.lower;
  const elapsed = moving + planned + residual.central;
  const elapsedUpper = moving + planned + residual.upper;
  return {
    distance_km: distance, moving_time_sec: moving, planned_event_time_sec: planned,
    residual_nonmoving_time_sec: residual.central, elapsed_time_sec: elapsed,
    arrival_at: departure + elapsed, warnings: residual.warnings,
    residual_lower_sec: residual.lower, residual_upper_sec: residual.upper,
    elapsed_lower_sec: elapsedLower, elapsed_upper_sec: elapsedUpper,
    arrival_lower_at: departure + elapsedLower, arrival_upper_at: departure + elapsedUpper,
    interval_band: residual.band.name, interval_sample_count: residual.band.sample_count,
    interval_fallback_source: residual.band.fallback_source
  };
}

function nextUp(x) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, x);
  let bits = view.getBigUint64(0); bits += x > 0 ? 1n : -1n; view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
function nextDown(x) { return -nextUp(-x); }

function scenarioTotal(distance, planned, quantile, artifact) {
  const value = interval(distance, artifact);
  const residual = quantile === 'p90' ? value.upper : value.lower;
  return distance * artifact.moving.median_sec_per_km + planned + residual;
}

function solvePiecewise(budget, planned, quantile, artifact) {
  const s = artifact.solver, bounds = [[0,30],[30,60],[60,100],[100,150],[150,s.upper_bound_km]];
  const candidates = [];
  for (const [lower, upper] of bounds) {
    const start = lower === 0 ? lower : nextUp(lower);
    if (scenarioTotal(start, planned, quantile, artifact) > budget) continue;
    if (scenarioTotal(upper, planned, quantile, artifact) <= budget) {
      if (upper === s.upper_bound_km) throw new Error('prototype uncertainty search bound remains feasible');
      candidates.push(nextDown(upper)); continue;
    }
    let lo = start, hi = upper;
    for (let i = 0; i < s.maximum_iterations && hi - lo > s.tolerance_km; i += 1) {
      const mid = (lo + hi) / 2;
      if (scenarioTotal(mid, planned, quantile, artifact) <= budget) lo = mid; else hi = mid;
    }
    candidates.push(lo);
  }
  return candidates.length ? Math.max(...candidates) : 0;
}

export function estimateDistance(input, rawArtifact) {
  const artifact = validateArtifact(rawArtifact);
  const departure = finite(input.departure_epoch_sec, '出発日時');
  const deadline = finite(input.deadline_epoch_sec, '帰宅期限');
  if (deadline <= departure) throw new Error('帰宅期限は出発時刻より後にしてください。');
  const budget = deadline - departure, planned = plannedSeconds(input.event_minutes || []), s = artifact.solver;
  if (planned >= budget) return {prototype_max_distance_km:0, moving_time_sec:0,
    planned_event_time_sec:planned, residual_nonmoving_time_sec:0, elapsed_time_sec:planned,
    warnings:interval(0, artifact).warnings, distance_lower_km:0, distance_upper_km:0, available_time_sec:budget,
    moving_lower_sec:0, moving_upper_sec:0, residual_lower_sec:0, residual_upper_sec:0};
  const total = d => estimateDestination({distance_km:d, departure_epoch_sec:departure, event_minutes:input.event_minutes || []}, artifact).elapsed_time_sec;
  if (total(s.upper_bound_km) <= budget) throw new Error('prototype search upper bound remains feasible');
  let low = 0, high = s.upper_bound_km, iterations = 0;
  while (high - low > s.tolerance_km && iterations < s.maximum_iterations) {
    const middle = (low + high) / 2;
    if (total(middle) <= budget) low = middle; else high = middle;
    iterations += 1;
  }
  if (high - low > s.tolerance_km) throw new Error('prototype distance solver did not converge');
  const central = estimateDestination({distance_km:low, departure_epoch_sec:departure, event_minutes:input.event_minutes || []}, artifact);
  let lower = Math.min(solvePiecewise(budget, planned, 'p90', artifact), low);
  let upper = Math.max(solvePiecewise(budget, planned, 'p10', artifact), low);
  const lowerBreakdown = estimateDestination({distance_km:lower, departure_epoch_sec:departure, event_minutes:input.event_minutes || []}, artifact);
  const upperBreakdown = estimateDestination({distance_km:upper, departure_epoch_sec:departure, event_minutes:input.event_minutes || []}, artifact);
  return {prototype_max_distance_km:low, moving_time_sec:central.moving_time_sec,
    planned_event_time_sec:planned, residual_nonmoving_time_sec:central.residual_nonmoving_time_sec,
    elapsed_time_sec:central.elapsed_time_sec, warnings:central.warnings,
    distance_lower_km:lower, distance_upper_km:upper, available_time_sec:budget,
    moving_lower_sec:lowerBreakdown.moving_time_sec, moving_upper_sec:upperBreakdown.moving_time_sec,
    residual_lower_sec:upperBreakdown.residual_lower_sec, residual_upper_sec:lowerBreakdown.residual_upper_sec};
}
