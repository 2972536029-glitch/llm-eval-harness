/**
 * 单文件 HTML 报告:数据内联在 <script type="application/json">,零外链资源——
 * CI artifact 里双击即看、离线可用、没有供应链面。
 * XSS 安全由构造保证而非靠转义回忆:数据里所有 "<" 都转义成 \u003c(不可能提前闭合 script 标签),
 * 客户端渲染全部走 createElement + textContent,绝不碰 innerHTML——回答原文里即使有
 * </script><script>alert(1) 也只会被当纯文本显示。
 */
import type { RunResult } from './types.ts';
import type { HistoryEntry } from './history.ts';

export function renderHtmlReport(run: RunResult, history: HistoryEntry[] = []): string {
  const dataJson = JSON.stringify({ run, history })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // 用函数替换:dataJson 里的 $&/$' 等模式串不会被特殊解释
  return TEMPLATE.replace('__DATA__', () => dataJson);
}

const TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM 输出评测报告</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1f2328;--sub:#57606a;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--acc:#0969da}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--sub);font-size:12px}
.banner{border-radius:8px;padding:10px 16px;margin:14px 0;font-weight:600}
.banner.pass{background:#dafbe1;color:var(--ok)}.banner.fail{background:#ffebe9;color:var(--bad)}
.partial{background:#fff8c5;color:var(--warn);border-radius:6px;padding:6px 12px;margin:0 0 10px;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px}
.card .k{font-size:12px;color:var(--sub)}.card .v{font-size:20px;font-weight:700;margin-top:2px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0}
h2{font-size:15px;margin:0 0 10px}
.bar{display:flex;align-items:center;gap:8px;margin:4px 0}.bar .label{width:48px;color:var(--sub);font-size:12px}
.bar .track{flex:1;background:var(--bg);border-radius:4px;height:14px;overflow:hidden}
.bar .fill{height:100%;background:var(--acc)}.bar .cnt{width:36px;font-size:12px;color:var(--sub);text-align:right}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;align-items:center}
.toolbar button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;color:var(--ink)}
.toolbar button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.toolbar input{border:1px solid var(--line);border-radius:6px;padding:4px 10px;font-size:12px;width:180px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--sub);font-weight:600;font-size:12px;white-space:nowrap}
tr.clk{cursor:pointer}tr.clk:hover{background:#f0f6ff}
.q{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{font-weight:700;white-space:nowrap}.status.pass{color:var(--ok)}.status.fail{color:var(--bad)}.status.error{color:var(--warn)}
pre{background:var(--bg);border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:12px;margin:6px 0}
.rule{margin:2px 0;font-size:13px}.rule.ok{color:var(--ok)}.rule.bad{color:var(--bad)}
.hit{font-size:12px;color:var(--sub);margin:2px 0}
#detail{display:none}
footer{color:var(--sub);font-size:12px;margin-top:18px}
</style>
</head>
<body>
<main>
<h1>LLM 输出评测报告 <span class="sub" id="tag"></span></h1>
<div class="sub" id="meta"></div>
<div id="banner" class="banner"></div>
<div id="partialNote" class="partial" style="display:none">本次为部分运行(--only / --filter):门禁与通过率只反映所选子集,历史对比只看重叠 case。</div>
<div class="cards" id="cards"></div>
<section><h2>judge 分数分布</h2><div id="hist"></div></section>
<section>
<h2>逐 case 明细(点击行展开详情)</h2>
<div class="toolbar" id="toolbar"></div>
<table><thead><tr><th>状态</th><th>case</th><th>问题</th><th>规则</th><th>judge</th><th>耗时</th></tr></thead><tbody id="rows"></tbody></table>
</section>
<section id="detail"></section>
<section id="trendSec" style="display:none"><h2>运行趋势(最近 10 次)</h2><div id="trend"></div></section>
<footer id="foot"></footer>
</main>
<script id="run-data" type="application/json">__DATA__</script>
<script>
(function(){
'use strict';
var payload = JSON.parse(document.getElementById('run-data').textContent);
var run = payload.run, history = payload.history || [];
function el(tag, cls, text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=String(text);return e;}
var m = run.meta, s = run.summary;

document.getElementById('tag').textContent = m.casesDir || '';
document.getElementById('meta').textContent =
  m.startedAt + ' · judge ' + m.judgeImpl + '(' + m.judgeModel + ',x' + m.judgeSamples + ')' +
  ' · 适配器调用 ' + m.adapterCalls + ' 次 / judge 调用 ' + m.judgeCalls + ' 次';
var banner = document.getElementById('banner');
banner.className = 'banner ' + (run.gate.passed ? 'pass' : 'fail');
banner.textContent = run.gate.passed ? 'PASS · 门禁通过' : 'FAIL · ' + run.gate.reasons.join(';');
if (m.partial) document.getElementById('partialNote').style.display = 'block';

function card(k, v){var c=el('div','card');c.appendChild(el('div','k',k));c.appendChild(el('div','v',v));return c;}
var cards = document.getElementById('cards');
cards.appendChild(card('规则通过率', (s.rulePassRate*100).toFixed(1)+'%'));
cards.appendChild(card('judge 均分', s.judgeAvg===null ? '—' : s.judgeAvg.toFixed(2)+'/5'));
cards.appendChild(card('用例', s.pass+'/'+s.total+(s.error?(' (error '+s.error+')'):'')));
cards.appendChild(card('估算成本', s.cost.totalEstCostYuan.toFixed(4)+' 元'));
cards.appendChild(card('耗时', (m.durationMs/1000).toFixed(1)+'s'));
if (m.reusedCount>0) cards.appendChild(card('缓存复用', m.reusedCount+' 条'));

var hist = document.getElementById('hist');
var maxCnt = 1;
[5,4,3,2,1].forEach(function(n){ if((s.judgeScores[n]||0)>maxCnt) maxCnt=s.judgeScores[n]; });
var any=false;
[5,4,3,2,1].forEach(function(n){
  var cnt = s.judgeScores[n]||0; if(!cnt) return; any=true;
  var row=el('div','bar');
  row.appendChild(el('div','label', n+' 分'));
  var track=el('div','track'); var fill=el('div','fill'); fill.style.width=Math.round(cnt/maxCnt*100)+'%';
  track.appendChild(fill); row.appendChild(track); row.appendChild(el('div','cnt','x'+cnt));
  hist.appendChild(row);
});
if(!any) hist.appendChild(el('div',null,'(无 judge 结果)'));

var state = { filter: 'all', q: '' };
var FILTERS = [['all','全部'],['pass','通过'],['fail','失败'],['error','错误'],['reused','复用']];
var toolbar = document.getElementById('toolbar');
FILTERS.forEach(function(f){
  var b = el('button', f[0]==='all'?'on':'', f[1]);
  b.onclick = function(){
    state.filter = f[0];
    Array.prototype.forEach.call(toolbar.querySelectorAll('button'), function(x){x.classList.remove('on');});
    b.classList.add('on'); renderRows();
  };
  toolbar.appendChild(b);
});
var search = document.createElement('input');
search.placeholder = '搜索 id / 问题';
search.oninput = function(){ state.q = search.value.trim(); renderRows(); };
toolbar.appendChild(search);

var rows = document.getElementById('rows');
function judgeCell(r){
  if (r.judge) {
    var t = r.judge.score+'/5';
    if (r.judge.samples && r.judge.samples.length>1) t += '(采样 '+r.judge.samples.join(',')+')';
    return t;
  }
  return r.judgeError ? '故障' : '—';
}
function match(r){
  if (state.filter!=='all' && r.status!==state.filter) return false;
  if (state.filter==='reused') return false;
  if (state.q && (r.id+' '+r.question).indexOf(state.q)<0) return false;
  return true;
}
function renderRows(){
  rows.textContent='';
  run.results.forEach(function(r){
    if(state.filter==='reused' && !r.reused) return;
    if(state.filter!=='all' && state.filter!=='reused' && r.status!==state.filter) return;
    if(state.q && (r.id+' '+r.question).indexOf(state.q)<0) return;
    var tr = el('tr','clk');
    var st = el('td','status '+r.status, (r.status==='pass'?'✓ ':r.status==='fail'?'✗ ':'! ')+(r.reused?'♻':''));
    tr.appendChild(st);
    tr.appendChild(el('td',null,r.id));
    var q=el('td'); q.appendChild(el('div','q',r.question)); tr.appendChild(q);
    tr.appendChild(el('td',null,(r.status==='error'?'—':(r.rules.filter(function(x){return x.pass;}).length+'/'+r.rules.length))));
    tr.appendChild(el('td',null,judgeCell(r)));
    tr.appendChild(el('td',null,r.adapterLatencyMs+'ms'));
    tr.onclick = function(){ showDetail(r); };
    rows.appendChild(tr);
  });
  if(!rows.children.length) rows.appendChild(el('tr',null,'')).appendChild(el('td',null,'(无匹配 case)'));
}

var detail = document.getElementById('detail');
function showDetail(r){
  detail.textContent='';
  detail.style.display='block';
  var h2=el('h2',null,r.id+' · ');
  var st=el('span','status '+r.status, r.status.toUpperCase()+(r.reused?' · 复用自缓存':''));
  h2.appendChild(st); detail.appendChild(h2);
  detail.appendChild(el('div','sub','问题'));
  detail.appendChild(el('pre',null,r.question));
  if(r.adapterError){ detail.appendChild(el('div','sub','适配器错误(重试 '+r.attempts+' 次)')); detail.appendChild(el('pre',null,r.adapterError)); }
  detail.appendChild(el('div','sub','规则断言'));
  r.rules.forEach(function(x){
    var line=el('div','rule '+(x.pass?'ok':'bad'),(x.pass?'✓ ':'✗ ')+x.name+':'+x.detail);
    detail.appendChild(line);
  });
  if(r.judge){
    detail.appendChild(el('div','sub','judge ' + r.judge.score + '/5' + (r.judge.samples&&r.judge.samples.length>1?(' · 采样 '+r.judge.samples.join(',')+' → 中位数'):'')));
    detail.appendChild(el('pre',null,r.judge.reasons));
    detail.appendChild(el('div','sub','tokens:in '+r.judge.promptTokens+' · out '+r.judge.completionTokens+' · '+r.judge.latencyMs+'ms'));
  } else if (r.judgeError) {
    detail.appendChild(el('div','sub','judge 故障'));
    detail.appendChild(el('pre',null,r.judgeError));
  }
  if(r.hits.length){
    detail.appendChild(el('div','sub','检索命中'));
    r.hits.forEach(function(h){ detail.appendChild(el('div','hit','材料'+h.material+(h.session!==null?(' · Session '+h.session):'')+' · '+(h.score===null?'—':h.score)+' · '+h.cite)); });
  }
  detail.appendChild(el('div','sub','回答原文'));
  detail.appendChild(el('pre',null,r.answer||'(空)'));
  detail.scrollIntoView({behavior:'smooth'});
}

if (history.length>1){
  document.getElementById('trendSec').style.display='block';
  var t=document.createElement('table');
  var thead=document.createElement('thead');
  var hr=document.createElement('tr');
  ['','时间','tag','通过','通过率','judge','成本(元)','门禁'].forEach(function(x){ hr.appendChild(el('th',null,x)); });
  thead.appendChild(hr); t.appendChild(thead);
  var tb=document.createElement('tbody');
  history.slice(-10).reverse().forEach(function(h){
    var tr=document.createElement('tr');
    tr.appendChild(el('td','status '+(h.gatePassed?'pass':'fail'), h.gatePassed?'✓':'✗'));
    tr.appendChild(el('td',null,h.ts.replace('T',' ').slice(0,19)));
    tr.appendChild(el('td',null,h.tag||'—'));
    tr.appendChild(el('td',null,h.pass+'/'+h.total+(h.complete?'':'(部分)')));
    tr.appendChild(el('td',null,(h.rulePassRate*100).toFixed(0)+'%'));
    tr.appendChild(el('td',null,h.judgeAvg===null?'—':h.judgeAvg.toFixed(2)));
    tr.appendChild(el('td',null,h.costYuan.toFixed(4)));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  document.getElementById('trend').appendChild(t);
}

document.getElementById('foot').textContent =
  'llm-eval-harness v0.2 · 生成于 '+m.finishedAt+' · 阈值:规则通过率 ≥ '+m.thresholds.rulePassRate+' 且 judge 均分 ≥ '+m.thresholds.judgeAvg;
renderRows();
})();
</script>
</body>
</html>
`;
