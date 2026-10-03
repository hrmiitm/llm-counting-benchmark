// Requires a local HTTP server and Chrome with --remote-debugging-port=9222.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.STORY_URL ?? 'http://127.0.0.1:8765/';
const target = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0; const pending = new Map(); const errors = [];
socket.onmessage = event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
function command(method, params = {}) { return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); }); }
async function evaluate(expression) {
  const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function loaded() {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.querySelector('#story-content')?.hidden === false`)) return;
    if (await evaluate(`document.querySelector('#story-status')?.classList.contains('error')`)) throw new Error(await evaluate(`document.querySelector('#story-status').textContent`));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Story failed to load');
}
try {
  await command('Runtime.enable'); await command('Page.enable');
  await command('Network.enable'); await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base }); await command('Page.bringToFront'); await loaded();
  await evaluate(`Promise.all([...document.images].map(i=>{i.loading='eager';return i.decode();}))`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.story-beat').length`), 4);
  assert.equal(await evaluate(`document.querySelector('.page-nav [aria-current]').textContent.trim()`), '01 The story');
  assert.ok((await evaluate(`document.querySelector('.page-nav a[href="compare.html"]').href`)).endsWith('/compare.html'));
  // Independently join and recompute raw input; do not use story statistics helpers.
  const truth = JSON.parse(await readFile(new URL('../eval2/metadata.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../eval2/manifest.json', import.meta.url), 'utf8'));
  const docs = (await Promise.all(manifest.files.map(async p=>({p,d:JSON.parse(await readFile(new URL(`../${p}`, import.meta.url),'utf8'))}))))
    .filter(x=>x.d.run_id==='2026-10-03T11:03:45.271545+00:00');
  const answers = docs.flatMap(({d})=>d.results.map(r=>({...r,actual:truth.find(i=>i.image===r.image)['actual-count']})));
  assert.equal(answers.length,54); assert.equal(answers.filter(r=>r.model_count===r.actual).length,6);
  assert.equal(await evaluate(`document.querySelector('#exact-revelation').textContent`),'Across the whole test, only 6 of 54 answers are exactly right.');
  assert.equal(await evaluate(`document.querySelector('#hero-actual').textContent`),'130');
  assert.equal(await evaluate(`document.querySelector('#hero-predicted').textContent`),'400');
  assert.equal(await evaluate(`document.querySelector('#hero-confidence').textContent`),'95%');
  const shown = await evaluate(`[...document.querySelectorAll('.ranking-row')].map(r=>({name:r.dataset.model,value:r.querySelector('.ranking-value').textContent}))`);
  for (const {d} of docs) {
    const expected=d.results.reduce((sum,r)=>sum+Math.abs(r.model_count-truth.find(i=>i.image===r.image)['actual-count'])/truth.find(i=>i.image===r.image)['actual-count']*100,0)/d.results.length;
    assert.equal(shown.find(r=>r.name===d.model).value,`${expected.toFixed(1)}%`);
  }
  assert.equal(shown[0].name,'google/gemini-3.8-flash');
  await evaluate(`document.querySelector('[data-measure="exact"]').click()`);
  for (const {d} of docs) {
    const value=await evaluate(`document.querySelector('.ranking-row[data-model="${d.model}"] .ranking-value').textContent`);
    assert.equal(value,`${d.results.filter(r=>r.model_count===truth.find(i=>i.image===r.image)['actual-count']).length} / 6`);
  }
  await evaluate(`document.querySelector('[data-measure="deviation"]').click()`);
  for (const cutoff of [0,80,90,95,100]) {
    await evaluate(`document.querySelector('#confidence-cutoff').value=${cutoff};document.querySelector('#confidence-cutoff').dispatchEvent(new Event('input'))`);
    const accepted=answers.filter(r=>r.confidence>=cutoff/100), exact=accepted.filter(r=>r.model_count===r.actual).length;
    assert.equal(await evaluate(`document.querySelectorAll('.answer-dot:not(.excluded)').length`),accepted.length);
    const text=await evaluate(`document.querySelector('#cutoff-summary').textContent`);
    if (accepted.length) { assert.ok(text.includes(`${accepted.length} of 54 answers accepted. ${exact} exact; ${accepted.length-exact} wrong.`)); }
    else assert.ok(text.includes('No answers meet this cutoff'));
  }
  await evaluate(`document.querySelector('#confidence-cutoff').value=90;document.querySelector('#confidence-cutoff').dispatchEvent(new Event('input'));document.querySelector('.answer-dot').click()`);
  assert.ok((await evaluate(`document.querySelector('#answer-detail').textContent`)).includes('predicted'));
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`),9);
  await evaluate(`document.querySelector('.cost-point').focus()`);
  assert.ok((await evaluate(`document.querySelector('#cost-detail').textContent`)).includes('google/gemini-3.8-flash'));
  assert.equal(await evaluate(`document.querySelectorAll('#source-links a').length`),10);
  const layout=await command('Page.getLayoutMetrics');
  const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height:layout.cssContentSize.height,scale:1}});
  await writeFile('/tmp/count-story-desktop.png',Buffer.from(shot.data,'base64'));
  for (const width of [390,360,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate(`renderCost()`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`overflow at ${width}`);
    assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`),9);
    assert.equal(await evaluate(`(()=>{const svg=document.querySelector('#cost-chart svg'),bounds=svg.getBoundingClientRect();return [...svg.querySelectorAll('text')].every(t=>{const r=t.getBoundingClientRect();return r.left>=bounds.left-1&&r.right<=bounds.right+1;});})()`),true,`chart labels at ${width}`);
    await evaluate(`scrollTo(0,0)`);
    const mobile=await command('Page.captureScreenshot',{format:'png'});await writeFile(`/tmp/count-story-mobile-${width}.png`,Buffer.from(mobile.data,'base64'));
  }

  // Theme and sharing checks exercise both pages through their visible controls.
  const contrastAudit = `(()=>{
    const rgb=s=>(s.match(/[0-9.]+/g)||[]).slice(0,3).map(Number);
    const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const checks=[];
    const selectors='.hero-counts small,.byline,figcaption,.chart-subtitle,.ranking-label,.ranking-label small,.ranking-value,.page-nav a,.theme-toggle,.metric-switch button,.cutoff-summary,.answer-detail,.caveat p,.methodology p,.explore-link,.result-cell .metric-label,.result-cell .metric-value,.summary-table td,.chart-tick,.chart-axis,.model-spec,.model-name,.provider-heading th,.overview li,.chart-legend button';
    for(const el of document.querySelectorAll(selectors)) {
      if(!el.getClientRects().length) continue;
      const style=getComputedStyle(el); let parent=el, bg='';
      while(parent){bg=getComputedStyle(parent).backgroundColor;if(!['transparent','rgba(0, 0, 0, 0)'].includes(bg))break;parent=parent.parentElement;}
      const fg=el.namespaceURI.includes('svg')?style.fill:style.color;
      const a=lum(rgb(fg)), b=lum(rgb(bg)); const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      if(!Number.isFinite(ratio)||ratio<4.5) checks.push({text:el.textContent.slice(0,55),ratio,fg,bg});
    }
    return checks;
  })()`;
  async function snapshot(path,selector) {
    let params={format:'png'};
    if(selector){const clip=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`);params={...params,captureBeyondViewport:true,clip};}
    const shot=await command('Page.captureScreenshot',params);await writeFile(path,Buffer.from(shot.data,'base64'));
  }
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-measure="exact"]').click();document.querySelector('#confidence-cutoff').value=95;document.querySelector('#confidence-cutoff').dispatchEvent(new Event('input'))`);
  const shared=await evaluate(`location.href`);
  assert.ok(shared.includes('measure=exact')&&shared.includes('cutoff=95'));
  await command('Page.navigate',{url:shared});await loaded();
  assert.equal(await evaluate(`document.querySelector('#confidence-cutoff').value`),'95');
  assert.equal(await evaluate(`document.querySelector('[data-measure="exact"]').getAttribute('aria-pressed')`),'true');
  await evaluate(`document.querySelector('[data-measure="deviation"]').click();document.querySelector('#confidence-cutoff').value=90;document.querySelector('#confidence-cutoff').dispatchEvent(new Event('input'));document.querySelector('.answer-dot').focus()`);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  assert.equal(await evaluate(`document.activeElement===document.querySelectorAll('.answer-dot')[1]`),true);
  assert.ok((await evaluate(`document.querySelector('#answer-detail').textContent`)).includes('ground truth'));
  for(const theme of ['dark','light']) {
    if(await evaluate(`document.documentElement.dataset.theme`) !== theme) await evaluate(`document.querySelector('#theme-toggle').click()`);
    assert.equal(await evaluate(`document.documentElement.dataset.theme`),theme);
    assert.deepEqual(await evaluate(contrastAudit),[],`${theme} story text contrast`);
    await evaluate(`scrollTo(0,0)`);await snapshot(`/tmp/count-story-${theme}-desktop.png`);
    await snapshot(`/tmp/count-confidence-${theme}.png`,'#confidence');
    await snapshot(`/tmp/count-cost-${theme}.png`,'#cost');
    for(const width of [390,360]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
      await evaluate(`renderCost()`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`${theme} story at ${width}`);
      assert.equal(await evaluate(`[...document.querySelectorAll('.answer-dot')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44;})`),true);
      await evaluate(`scrollTo(0,0)`);await snapshot(`/tmp/count-story-${theme}-${width}.png`);
    }
    await command('Page.navigate',{url:new URL('compare.html',base).href});
    for(let i=0;i<100;i++){if(await evaluate(`document.querySelector('#reload')?.disabled===false&&document.querySelectorAll('.result-cell').length===54`))break;if(i===99)throw new Error('Explorer did not load');await new Promise(r=>setTimeout(r,100));}
    assert.equal(await evaluate(`document.documentElement.dataset.theme`),theme,`theme carries to explorer`);
    assert.deepEqual(await evaluate(contrastAudit),[],`${theme} explorer text contrast`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);
    await snapshot(`/tmp/count-explorer-${theme}-360.png`);
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await snapshot(`/tmp/count-explorer-${theme}-desktop.png`);
    await evaluate(`document.querySelector('#search').value='gemini';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('#provider-grouping').value='desc';document.querySelector('#provider-grouping').dispatchEvent(new Event('change'))`);
    const explorerURL=await evaluate(`location.href`);
    assert.ok(explorerURL.includes('q=gemini')&&explorerURL.includes('provider=desc'));
    await command('Page.navigate',{url:explorerURL});
    for(let i=0;i<100;i++){if(await evaluate(`document.querySelector('#reload')?.disabled===false&&document.querySelectorAll('.result-cell').length===12`))break;if(i===99)throw new Error('Shared explorer did not load');await new Promise(r=>setTimeout(r,100));}
    assert.equal(await evaluate(`document.querySelector('#search').value`),'gemini');
    assert.equal(await evaluate(`document.querySelector('#provider-grouping').value`),'desc');
    await command('Page.navigate',{url:base});await loaded();
  }
  // Follow the OS preference until the reader explicitly chooses a mode.
  await evaluate(`localStorage.removeItem('count-compare-theme')`);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
  await command('Page.navigate',{url:base});await loaded();
  assert.equal(await evaluate(`document.documentElement.dataset.theme`),'dark');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  for(let i=0;i<30;i++){if(await evaluate(`document.documentElement.dataset.theme==='light'`))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(await evaluate(`document.documentElement.dataset.theme`),'light');
  await command('Page.bringToFront');
  await evaluate(`document.querySelector('#theme-toggle').focus()`);
  assert.equal(await evaluate(`document.activeElement.id`),'theme-toggle');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await evaluate(`document.documentElement.dataset.theme`),'dark');
  await command('Page.navigate',{url:base});await loaded();
  assert.equal(await evaluate(`document.documentElement.dataset.theme`),'dark',`explicit choice persists after reload`);

  // Exercise the actual user-facing missing-data path without touching saved files.
  await evaluate(`window.fetch=()=>Promise.resolve(new Response('',{status:404}));loadStory()`);
  assert.equal(await evaluate(`document.querySelector('#story-content').hidden`),true);
  assert.ok((await evaluate(`document.querySelector('#story-status').textContent`)).includes('could not be loaded'));
  assert.ok((await evaluate(`document.querySelector('#story-status a').href`)).endsWith('/compare.html'));
  assert.deepEqual(errors,[]);
  console.log('Passed: raw pilot figures, nine model rankings, exact-match switch, five confidence cutoffs, answer/cost details, source links, desktop and 360/390px layouts, light/dark contrast, cross-page theme persistence, keyboard navigation, shared URLs, and missing-data notice.');
} finally { socket.close(); }
