import {RUNTIME_VERSION, estimateDestination, estimateDistance, validateArtifact} from './runtime/ride_planning_runtime.js';
const presets=[['collection','カード収集',10,true],['lunch','昼食',40,true],['snack','軽食',20,false],['sightseeing','観光・見学',30,false],['other','その他',10,false]];
let artifact;
let buildInfo;
let serviceWorkerRegistration;
let uiInitialized=false;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const duration=sec=>{const m=Math.floor(sec/60+.5),h=Math.floor(m/60);return h?`${h}時間${String(m%60).padStart(2,'0')}分`:`${m}分`};
const km=value=>`${Number(value).toFixed(1)} km`;
function eventRows(){return presets.map(([code,label,minutes,checked])=>`<div class="event"><label><input type="checkbox" name="selected_event" value="${code}"${checked?' checked':''}><span>${label}</span></label><label class="minutes"><input type="number" name="event_${code}" value="${minutes}" min="0" step="1" inputmode="numeric"><span>分</span></label></div>`).join('')}
document.querySelectorAll('[data-events]').forEach(node=>node.innerHTML=eventRows());
function selected(form){return [...form.querySelectorAll('[name=selected_event]:checked')].map(box=>{const v=Number(new FormData(form).get(`event_${box.value}`));if(!Number.isInteger(v)||v<0)throw new Error('予定イベント時間は0以上の整数で入力してください。');return v})}
function unexpected(form){if(!form.elements.unexpected_enabled.checked)return 0;const v=Number(form.elements.unexpected_buffer_minutes.value);if(!Number.isInteger(v)||v<0)throw new Error('バッファ時間は0以上の整数で入力してください。');return v}
function updateSubmitState(form){const button=form.querySelector('button.primary');if(!button)return;const enabled=artifact!==undefined&&form.checkValidity();button.disabled=!enabled;if(enabled)button.removeAttribute('disabled');else button.setAttribute('disabled','')}
function updateAllSubmitStates(){if(!uiInitialized)return;document.querySelectorAll('form').forEach(updateSubmitState)}
function initializeSubmitStates(){if(uiInitialized)return;const forms=[...document.querySelectorAll('form')];if(!forms.length)return;uiInitialized=true;forms.forEach(form=>{form.addEventListener('input',()=>updateSubmitState(form));form.addEventListener('change',()=>updateSubmitState(form))});updateAllSubmitStates()}
initializeSubmitStates();
if(!uiInitialized)document.addEventListener('DOMContentLoaded',initializeSubmitStates,{once:true});
window.addEventListener('pageshow',updateAllSubmitStates);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateAllSubmitStates()});
function epoch(time){const now=new Date(),parts=time.split(':').map(Number);return new Date(now.getFullYear(),now.getMonth(),now.getDate(),parts[0],parts[1]).getTime()/1000}
function clock(departureEpoch,arrivalEpoch){const d=new Date(arrivalEpoch*1000),days=Math.floor((arrivalEpoch-departureEpoch)/86400);return `${days>0?'翌日 ':''}${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function allocation(moving,natural,unexpected,planned){const values=[[moving,'走行時間','moving-fill'],[natural,'通常停止時間','natural-fill'],[unexpected,'予備時間','unexpected-fill'],[planned,'予定イベント時間','planned-fill']],total=values.reduce((sum,[value])=>sum+value,0);if(total<=0)return '<div class="notice">データがありません</div>';let x=0;const visible=values.filter(([value])=>value>0);return `<svg class="allocation" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="標準予測の時間配分">${visible.map(([value,label,style],index)=>{const width=index===visible.length-1?100-x:value/total*100,inside=width>=22,part=`<title>${label} ${duration(value)}</title><rect class="${style}" x="${x}" width="${width}" height="12"/>${inside?`<text x="${x+width/2}" y="7.2" text-anchor="middle" font-size="3">${duration(value)}</text>`:''}`;x+=width;return part}).join('')}</svg>`}
function allocationLegend(){return '<ul class="allocation-legend" aria-label="内訳グラフの凡例"><li class="moving"><span aria-hidden="true">走</span>走行</li><li class="natural"><span aria-hidden="true">止</span>通常停止</li><li class="unexpected"><span aria-hidden="true">備</span>予備</li><li class="planned"><span aria-hidden="true">予</span>予定イベント</li></ul>'}
const component=(kind,icon,title,copy,value)=>`<div class="component ${kind}"><span class="icon">${icon}</span><span class="copy"><strong>${title}</strong><br><small>${copy}</small></span><span class="value">${value}</span></div>`;
function warning(codes){return codes.includes('residual_ols_long_distance_low_evidence')?'<div class="notice">150km以上は過去の対象ライドが少なく、予測誤差が大きい可能性があります。</div>':''}
function reveal(node,html){node.innerHTML=html;node.scrollIntoView({behavior:'smooth',block:'start'})}
function rangeBasis(){return '<small class="range-basis">過去実績から推定した目安です（必ず収まる範囲ではありません）</small>'}
function directResult(r,input){return `<section class="result"><h1>計算結果</h1><div class="primary-result"><span>標準予測</span><strong>${duration(r.elapsed_time_sec)}</strong><b>${clock(input.epoch,r.arrival_at)} 帰宅</b></div><div class="supporting-range"><strong>${duration(r.elapsed_lower_sec)} 〜 ${duration(r.elapsed_upper_sec)}</strong><small>${clock(input.epoch,r.arrival_lower_at)} 〜 ${clock(input.epoch,r.arrival_upper_at)}</small>${rangeBasis()}</div><p class="departure">出発 ${esc(input.departure_time)}</p><h2>所要時間の内訳（標準予測）</h2>${allocation(r.moving_time_sec,r.natural_stop_time_sec,r.unexpected_buffer_sec,r.planned_event_time_sec)}${allocationLegend()}<div class="breakdown">${component('moving','走','走行時間','過去の走行実績から距離に応じて推定',duration(r.moving_time_sec))}${component('natural','止','通常停止時間','走行中に自然に発生する停止時間を、距離帯ごとの過去実績から推定します。',duration(r.natural_stop_time_sec))}${component('unexpected','備','予備時間','ユーザーが任意で追加する余裕時間です。',duration(r.unexpected_buffer_sec))}${component('planned','予','予定イベント時間','ユーザーが事前入力したイベント時間の合計',duration(r.planned_event_time_sec))}</div><p class="range-note">予定イベントと予備時間は各予測へ同じだけ加算します。</p>${warning(r.warnings)}</section>`}
function distanceResult(r,input){return `<section class="result"><h1>計算結果</h1><div class="primary-result"><span>標準予測</span><strong>${km(r.prototype_max_distance_km)}</strong></div><div class="supporting-range"><strong>${km(r.distance_lower_km)} 〜 ${km(r.distance_upper_km)}</strong>${rangeBasis()}</div><div class="fixed"><div><span>出発時刻</span><br><strong>${esc(input.departure_time)}</strong></div><b>→</b><div><span>帰宅期限</span><br><strong>${esc(input.deadline_time)}</strong></div><div><span>利用可能時間</span><br><strong>${duration(r.available_time_sec)}</strong></div></div><h2>所要時間の内訳（標準予測）</h2>${allocation(r.moving_time_sec,r.natural_stop_time_sec,r.unexpected_buffer_sec,r.planned_event_time_sec)}${allocationLegend()}<div class="breakdown">${component('moving','走','走行時間','過去の走行実績から距離に応じて推定',duration(r.moving_time_sec))}${component('natural','止','通常停止時間','走行中に自然に発生する停止時間を、距離帯ごとの過去実績から推定します。',duration(r.natural_stop_time_sec))}${component('unexpected','備','予備時間','ユーザーが任意で追加する余裕時間です。',duration(r.unexpected_buffer_sec))}${component('planned','予','予定イベント時間','ユーザーが事前入力したイベント時間の合計',duration(r.planned_event_time_sec))}</div>${warning(r.warnings)}</section>`}
document.querySelectorAll('.mode-nav button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.mode-nav button').forEach(b=>b.classList.toggle('active',b===button));document.querySelector('#destination-view').classList.toggle('hidden',button.dataset.mode!=='destination');document.querySelector('#distance-view').classList.toggle('hidden',button.dataset.mode!=='distance')}));
document.querySelectorAll('[data-time]').forEach(button=>button.addEventListener('click',()=>button.closest('form').elements.departure_time.value=button.dataset.time));
document.querySelectorAll('.current-time').forEach(button=>button.addEventListener('click',()=>{const n=new Date();button.closest('form').elements.departure_time.value=`${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`}));
document.querySelector('#destination-form').addEventListener('submit',event=>{event.preventDefault();const node=document.querySelector('#destination-result');try{const form=event.currentTarget,d=Number(form.elements.distance_km.value),time=form.elements.departure_time.value,e=epoch(time),r=estimateDestination({distance_km:d,departure_epoch_sec:e,event_minutes:selected(form),unexpected_buffer_minutes:unexpected(form)},artifact);reveal(node,directResult(r,{departure_time:time,epoch:e}))}catch(e){reveal(node,`<div class="error">${esc(e.message)}</div>`)}});
document.querySelector('#distance-form').addEventListener('submit',event=>{event.preventDefault();const node=document.querySelector('#distance-result');try{const form=event.currentTarget,s=form.elements.departure_time.value,d=form.elements.deadline_time.value,start=epoch(s),end=epoch(d);if(end<=start)throw new Error('帰宅期限は出発時刻より後にしてください。');const r=estimateDistance({departure_epoch_sec:start,deadline_epoch_sec:end,event_minutes:selected(form),unexpected_buffer_minutes:unexpected(form)},artifact);reveal(node,distanceResult(r,{departure_time:s,deadline_time:d}))}catch(e){reveal(node,`<div class="error">${esc(e.message)}</div>`)}});
const setText=(id,value)=>{const node=document.querySelector(id);if(node)node.textContent=value||'取得不可'};
const short=value=>value&&value!=='unknown'?value.slice(0,12):'取得不可';
const runtimeGeneration=value=>{const match=String(value||'').match(/runtime-v(\d+)(?:$|[.-])/);return match?Number(match[1]):null};
const withTimeout=(promise,timeout,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`${label}がタイムアウトしました。`)),timeout);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})});
const fetchWithin=(url,label,timeout=3000)=>withTimeout(fetch(url,{cache:'no-store'}),timeout,label);
async function sha256(buffer){if(!globalThis.crypto?.subtle)throw new Error('SHA-256確認は非対応です。');const digest=await withTimeout(crypto.subtle.digest('SHA-256',buffer),3000,'Artifact SHA確認');return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')}
function showCompatibility(actualSha){
  const compatible=Boolean(buildInfo&&actualSha)&&buildInfo.schema_version==='ride-planning-build-info-v1'&&
    buildInfo.expected_runtime_version===RUNTIME_VERSION&&artifact?.runtime_version===RUNTIME_VERSION&&
    buildInfo.expected_runtime_schema===artifact?.schema_version&&
    buildInfo.ui_runtime_generation===runtimeGeneration(RUNTIME_VERSION)&&
    buildInfo.artifact_sha256===actualSha;
  document.querySelector('#cache-warning').classList.toggle('hidden',compatible);
  return compatible;
}
function workerMessage(worker,type,timeout=3000){return new Promise((resolve,reject)=>{if(!worker){reject(new Error('Service Workerが未登録です。'));return}const channel=new MessageChannel();const timer=setTimeout(()=>reject(new Error(`Service Worker ${type}がタイムアウトしました。`)),timeout);channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data)};try{worker.postMessage({type},[channel.port2])}catch(error){clearTimeout(timer);reject(error)}})}
async function renderServiceWorkerInfo(registration){
  const worker=navigator.serviceWorker.controller||registration?.active;
  try{const value=await workerMessage(worker,'GET_VERSION');
    setText('#cache-id',value?.cacheId?value.cacheId.replace('ride-planning-lab-',''):'取得失敗');
    setText('#sw-version',value?.serviceWorkerVersion||'取得失敗');setText('#cache-updated-at',value?.cacheUpdatedAt||'取得失敗');
  }catch(error){setText('#cache-id',worker?'取得失敗':'未登録');setText('#sw-version',worker?'取得失敗':'未登録');setText('#cache-updated-at','取得失敗')}
}
async function waitForWaiting(registration,timeout=5000){
  if(registration.waiting)return registration.waiting;
  return new Promise(resolve=>{const timer=setTimeout(()=>resolve(registration.waiting),timeout);const installing=registration.installing;
    if(!installing){clearTimeout(timer);resolve(null);return}installing.addEventListener('statechange',()=>{if(installing.state==='installed'||installing.state==='redundant'){clearTimeout(timer);resolve(registration.waiting)}})});
}
async function refreshAssets(){
  const button=document.querySelector('#refresh-assets'),status=document.querySelector('#refresh-status');button.disabled=true;status.textContent='最新版を確認しています…';
  try{
    if(!('serviceWorker' in navigator))throw new Error('Service Workerを利用できません。');
    const registration=serviceWorkerRegistration||await withTimeout(navigator.serviceWorker.ready,3000,'Service Worker登録');await withTimeout(registration.update(),5000,'Service Worker更新');
    const waiting=await waitForWaiting(registration);if(waiting){const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));await workerMessage(waiting,'ACTIVATE_UPDATE');await Promise.race([changed,new Promise(resolve=>setTimeout(resolve,3000))])}
    const refreshed=await workerMessage(navigator.serviceWorker.controller||registration.active,'REFRESH_ASSETS',10000);
    if(!refreshed?.refreshed)throw new Error('最新assetを取得できませんでした。');
    status.textContent='最新版を取得しました。再読み込みします…';location.reload();
  }catch(error){status.textContent=`更新できませんでした: ${error?.message||'原因不明のエラー'}`;button.disabled=false}
}
document.querySelector('#refresh-assets').addEventListener('click',refreshAssets);
async function loadArtifact(){
  setText('#runtime-version',RUNTIME_VERSION);
  try{const response=await fetchWithin('./artifacts/ride_planning_runtime_v1.json','予測データ');if(!response.ok)throw new Error(`予測データ取得失敗 (${response.status})`);
    const bytes=await withTimeout(response.arrayBuffer(),3000,'予測データ読込');artifact=validateArtifact(JSON.parse(new TextDecoder().decode(bytes)));updateAllSubmitStates();
    try{const digest=await sha256(bytes);setText('#artifact-sha',short(digest));return digest}catch(error){setText('#artifact-sha',error.message.includes('非対応')?'非対応':'取得失敗');return null}
  }catch(error){artifact=undefined;setText('#artifact-sha','取得失敗');updateAllSubmitStates();const node=document.querySelector('#fatal');node.textContent=`${error.message} 初回利用またはcache消去後は、通信可能な状態で開き直してください。`;node.classList.remove('hidden');return null}
}
async function loadBuildInfo(){
  try{const response=await fetchWithin('./build-info.json','ビルド情報');if(!response.ok)throw new Error(`ビルド情報取得失敗 (${response.status})`);buildInfo=await withTimeout(response.json(),3000,'ビルド情報読込');setText('#ui-version',`${buildInfo.ui_version} (${short(buildInfo.ui_commit)})`);setText('#build-time',buildInfo.build_at);return buildInfo}
  catch(error){buildInfo=undefined;setText('#ui-version','取得失敗');setText('#build-time','取得失敗');return null}
}
async function initializeVersionInfo(){const [actualSha]=await Promise.all([loadArtifact(),loadBuildInfo()]);showCompatibility(actualSha)}
initializeVersionInfo();
async function initializeServiceWorker(){
  if(!('serviceWorker' in navigator)){setText('#cache-id','非対応');setText('#sw-version','非対応');setText('#cache-updated-at','非対応');return}
  try{await withTimeout((async()=>{const registration=await navigator.serviceWorker.register('./service-worker.js');serviceWorkerRegistration=registration;const ready=await navigator.serviceWorker.ready;await renderServiceWorkerInfo(ready)})(),3500,'Service Worker情報')}
  catch(error){setText('#cache-id','取得失敗');setText('#sw-version','取得失敗');setText('#cache-updated-at','取得失敗')}
}
initializeServiceWorker();
setTimeout(()=>document.querySelectorAll('.version-panel dd').forEach(node=>{if(node.textContent==='確認中')node.textContent='取得失敗'}),4000);
