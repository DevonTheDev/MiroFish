import assert from 'node:assert/strict'
import test from 'node:test'
import { mountReportFiles, syntheticReport as report, ok, flush, file, chooseFile, previewFile, acceptFile } from './helpers/saved-report-files-view-fixture.js'

const action = (view, id) => { const node = view.byId(id); assert.ok(node, id); return node.props.onClick }
const invoke = callback => callback({ button: 0, preventDefault() {}, stopPropagation() {} })
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
const noEffects = view => { assert.ok(Object.values(view.requests?.calls ?? {}).every(calls => !calls.length)); assert.deepEqual(view.networkCalls, []); assert.deepEqual(view.storageWrites, []) }
const accepted = (view, id) => assert.equal(view.text(view.byId('accepted-report-id')), id)

for (const initialPath of ['/', '/reports']) test(`entry remains available at ${initialPath} even when backend reads fail`, async () => {
  const view = await mountReportFiles({ initialPath })
  try {
    Object.values(view.requests.calls).flat().forEach(call => call.reject(Error('offline'))); await flush()
    assert.ok(view.byId('open-report-files'), 'An independent report files entry is missing')
    await view.click('open-report-files'); assert.equal(view.router.currentRoute.value.name, 'SavedReportFiles')
    assert.ok(view.byId('report-file'), 'The independent report file picker is missing')
  } finally { view.unmount() }
})
test('accepted live observation has a separate JSON download including unavailable content', async () => {
  const value=report(); Object.assign(value,{content_available:false,content_source:null,markdown_content:null,content_bytes:null,content_revision:null,content_error:'not_saved'})
  const view=await mountReportFiles({initialPath:'/reports?report_id=report_A'})
  try {
    view.requests.calls.getSavedReport[0].resolve(ok(value)); await flush()
    assert.ok(view.byId('download-observation'),'The saved report observation JSON download is missing')
    await view.click('download-observation')
    assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()).observation,value)
    assert.ok(view.byId('download').props.disabled)
  } finally {view.unmount()}
})

for (const locale of ['en','zh']) test(`preview, explicit Open, exact metadata and literal reader work in ${locale}`, async () => {
  const view=await mountReportFiles({locale})
  try {
    const value=report(); value.title='<img src=x>'; value.created_at='<script>saved time</script>'; value.status='unknown'; value.simulation_id='arbitrary saved identifier'
    noEffects(view); assert.ok(view.byId('clear-file').props.disabled)
    await previewFile(view,value,'../<img>.json')
    assert.equal(view.byId('accepted-file'),undefined); assert.equal(view.text(view.byId('preview-filename')),'../<img>.json')
    for (const key of ['report_id','simulation_id','title','summary_preview','requirement_preview','status','created_at','observed_at','metadata_revision','content_source','content_revision']) assert.ok(view.text(view.byId('file-preview')).includes(value[key]),key)
    await view.click('open-file'); accepted(view,value.report_id); assert.equal(view.byId('file-preview'),undefined)
    assert.equal(view.text(view.byId('markdown')),value.markdown_content)
    assert.equal(view.all(n=>['img','script'].includes(n.type)||n.props.innerHTML).length,0)
    await view.input('report-find','needle'); assert.equal(view.all(n=>n.type==='mark').length,2)
    await view.change('report-find-case',true); assert.equal(view.all(n=>n.type==='mark').length,1)
    await view.click('download-file'); assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()).observation,value)
    await view.click('download-markdown'); assert.equal(await view.downloads.at(-1).blob.text(),value.markdown_content)
    await view.change('file-language',locale==='en'?'zh':'en'); accepted(view,value.report_id); noEffects(view); assert.deepEqual(view.warnings,[])
  } finally {view.unmount()}
  assert.equal(view.blobs.size,0); assert.ok(view.anchors.every(a=>!a.attached))
})

test('accepted A stays searchable during B read, preview, invalid replacement and cancellation; opening B resets only current reader',async()=>{
  const view=await mountReportFiles()
  try {
    const a=report(),b=report('report_A','different body\r\nNeedle')
    await acceptFile(view,a,'A.json'); await view.click('capture-left')
    const read=defer(),{pending}=await chooseFile(view,file(b,'B.json',{arrayBuffer:()=>read.promise}))
    await view.input('report-find','needle'); await view.change('report-find-case',true); await view.change('file-language','zh')
    accepted(view,a.report_id); assert.ok(view.byId('file-loading')); await view.click('download-file')
    read.resolve(await file(b).arrayBuffer()); await pending; await flush(); assert.ok(view.byId('file-preview'))
    assert.equal(view.byId('report-find').props.value,'needle'); await view.click('cancel-file'); assert.equal(view.byId('file-preview'),undefined)
    await previewFile(view,'{private error}'); assert.ok(view.byId('file-error')); assert.doesNotMatch(view.text(),/private error/); accepted(view,a.report_id)
    await chooseFile(view,null); assert.equal(view.byId('file-error'),undefined)
    await acceptFile(view,b,'B.json'); assert.equal(view.byId('report-find').props.value,''); assert.equal(view.text(view.byId('markdown')),b.markdown_content)
    await view.click('capture-right'); assert.equal(view.text(view.byId('comparison-left-text')),a.markdown_content); assert.equal(view.text(view.byId('comparison-right-text')),b.markdown_content)
    await view.click('clear-file'); assert.equal(view.byId('accepted-file'),undefined); assert.ok(view.byId('comparison-status')); assert.ok(view.byId('capture-left').props.disabled)
    await view.click('comparison-left-download'); assert.equal(await view.downloads.at(-1).blob.text(),a.markdown_content)
    await view.click('comparison-clear'); assert.equal(view.byId('comparison-status'),undefined); noEffects(view)
  } finally {view.unmount()}
})

for (const cacheHandlers of [true,false]) for (const resolution of ['resolve','reject']) test(`stale reads and retained callbacks cannot replace same-ID A → B → A (${cacheHandlers}, ${resolution})`,async()=>{
  const scrolls=[], view=await mountReportFiles({cacheHandlers,deferredScrolls:scrolls})
  try {
    const a=report(), b=report('report_A','B Needle')
    await acceptFile(view,a); await view.input('report-find','needle')
    const staleInput=view.byId('report-find').props.onInput, staleNext=action(view,'report-find-next'), staleCapture=action(view,'capture-left')
    const staleClear=action(view,'clear-file'),staleDownload=action(view,'download-file')
    await previewFile(view,b); const staleOpen=action(view,'open-file'), staleCancel=action(view,'cancel-file'),staleSelect=view.byId('report-file').props.onChange
    const read=defer(),{pending}=await chooseFile(view,file(b,'late.json',{arrayBuffer:()=>read.promise}))
    const loadingCancel=action(view,'cancel-file')
    await acceptFile(view,b); await acceptFile(view,a)
    for(const fn of [staleNext,staleCapture,staleClear,staleDownload,staleOpen,staleCancel,loadingCancel]) invoke(fn)
    staleInput({target:{value:'retired'}})
    let reads=0; await staleSelect({target:{files:[file(a,'stale.json',{arrayBuffer(){reads++;throw Error('stale')}})],value:'stale'}})
    read[resolution](resolution==='resolve'?await file(b).arrayBuffer():Error('private late failure')); await pending; await flush()
    const before=view.scrollCalls.length; scrolls.forEach(fn=>fn()); await flush(); assert.equal(view.scrollCalls.length,before)
    assert.equal(reads,0); accepted(view,a.report_id); assert.equal(view.text(view.byId('markdown')),a.markdown_content); assert.equal(view.byId('report-find').props.value,'')
    assert.equal(view.byId('file-preview'),undefined);assert.equal(view.byId('file-error'),undefined); assert.equal(view.downloads.length,0); assert.equal(view.byId('comparison-left-text'),undefined); noEffects(view)
  } finally {view.unmount()}
})

for(const actionId of ['cancel-file','clear-file']) for(const resolution of ['resolve','reject']) test(`${actionId} retires pending ${resolution} with the intended comparison lifetime`,async()=>{
  const view=await mountReportFiles()
  try {
    await acceptFile(view,report()); await view.click('capture-left')
    const read=defer(),{pending}=await chooseFile(view,file(report('late'),'late.json',{arrayBuffer:()=>read.promise}))
    await view.click(actionId); read[resolution](resolution==='resolve'?await file(report('late')).arrayBuffer():Error('private')); await pending; await flush()
    assert.equal(view.byId('file-loading'),undefined); assert.equal(view.byId('file-preview'),undefined); assert.equal(view.byId('file-error'),undefined)
    assert.equal(!!view.byId('accepted-file'),actionId==='cancel-file'); assert.ok(view.byId('comparison-left-text')); noEffects(view)
  } finally {view.unmount()}
})

for (const route of ['/runtime','/report-files?new=1']) test(`route ${route}, return and unmount retire session state and all retained callbacks`,async()=>{
  const view=await mountReportFiles(), read=defer()
  await acceptFile(view,report()); await view.click('capture-left'); await view.click('download-file')
  const clear=action(view,'clear-file'), download=action(view,'download-file'), comparisonDownload=action(view,'comparison-left-download')
  const {pending}=await chooseFile(view,file(report('late'),'late.json',{arrayBuffer:()=>read.promise}))
  const cancel=action(view,'cancel-file'); await view.navigate(route); for(const fn of [clear,download,comparisonDownload,cancel])invoke(fn)
  read.resolve(await file(report('late')).arrayBuffer());await pending;await flush();assert.equal(view.blobs.size,0);assert.equal(view.downloads.length,1)
  await view.back(); assert.equal(view.byId('accepted-file'),undefined); assert.equal(view.byId('comparison-left-text'),undefined);assert.equal(view.byId('file-preview'),undefined)
  await acceptFile(view,report()); const select=view.byId('report-file').props.onChange; view.unmount(); await select({target:{files:[file(report())],value:'x'}});invoke(clear);invoke(download);await flush();assert.equal(view.blobs.size,0);noEffects(view)
})

for(const count of [0,1,2]) test(`native live FileList count ${count} is captured before picker reset`,async()=>{
  const view=await mountReportFiles()
  try {
    await acceptFile(view,report()); let reads=0;const chosen=file(report('next'));const buffer=await chosen.arrayBuffer();chosen.arrayBuffer=async()=>{reads++;return buffer}
    const files={length:count,...(count?{0:chosen}:{}),...(count===2?{1:chosen}:{})};let value='native.json'
    const target={files,get value(){return value},set value(next){value=next;delete files[0];delete files[1];files.length=0}}
    await view.byId('report-file').props.onChange({target});await flush();assert.equal(reads,count===1?1:0);assert.equal(value,'');accepted(view,'report_A')
    assert.equal(!!view.byId('file-preview'),count===1);assert.equal(!!view.byId('file-error'),count===2);noEffects(view)
  } finally {view.unmount()}
})

for(const variant of ['empty','unavailable','legacy']) test(`${variant} observations retain exact body availability and export`,async()=>{
  const view=await mountReportFiles(),value=report()
  try {
    if(variant==='empty')Object.assign(value,{markdown_content:'',content_bytes:0})
    if(variant==='unavailable')Object.assign(value,{content_available:false,markdown_content:null,content_bytes:null,content_revision:null,content_source:null,content_error:'not_saved'})
    if(variant==='legacy')Object.assign(value,{source:'legacy',content_source:'legacy_markdown',simulation_id:null,created_at:null,completed_at:null})
    await acceptFile(view,value);await view.click('download-file');assert.deepEqual(JSON.parse(await view.downloads.at(-1).blob.text()).observation,value)
    assert.equal(!!view.byId('download-markdown').props.disabled,variant==='unavailable');assert.equal(!!view.byId('markdown'),variant!=='unavailable');noEffects(view)
  } finally {view.unmount()}
})

for(const stage of ['beforeCreate','beforeAnchor','append','click','remove']) test(`download ${stage} failure cleans its resources and preserves pending read`,async()=>{
  const view=await mountReportFiles(),read=defer()
  try {
    await acceptFile(view,report()); const {pending}=await chooseFile(view,file(report('B'),'B.json',{arrayBuffer:()=>read.promise}))
    view.downloadHooks[stage]=()=>{throw Error('private '+stage)}; await view.click('download-file');assert.ok(view.byId('download-error'));assert.equal(view.blobs.size,0);assert.ok(view.anchors.every(a=>!a.attached));accepted(view,'report_A');assert.ok(view.byId('file-loading'));assert.doesNotMatch(view.text(),/private/)
    read.resolve(await file(report('B')).arrayBuffer());await pending;await flush();assert.ok(view.byId('file-preview'));noEffects(view)
  } finally {view.unmount()}
})

for(const stage of ['create','anchor','append','click','remove']) test(`reentrant ${stage} retirement cleans only its own URL and anchor`,async()=>{
  const view=await mountReportFiles()
  try {
    await acceptFile(view,report()); const clear=action(view,'clear-file')
    view.downloadHooks[stage]=()=>{delete view.downloadHooks[stage];invoke(clear)}
    await view.click('download-file');assert.equal(view.byId('accepted-file'),undefined);assert.equal(view.blobs.size,0);assert.ok(view.anchors.every(a=>!a.attached));noEffects(view)
  } finally {view.unmount()}
})

for(const stage of ['create','anchor','append','click','remove','revoke']) test(`reentrant ${stage} export cannot revoke a newer export`,async()=>{
  const view=await mountReportFiles()
  try {
    await acceptFile(view,report());const download=action(view,'download-file')
    if(stage==='revoke')await view.click('download-file')
    view.downloadHooks[stage]=()=>{delete view.downloadHooks[stage];invoke(download)}
    await view.click('download-file'); assert.equal(view.blobs.size,1);const lastUrl=[...view.blobs.keys()][0];assert.ok(!view.revokedUrls.includes(lastUrl));assert.ok(view.anchors.every(a=>!a.attached));noEffects(view)
    await view.click('clear-file');assert.equal(view.blobs.size,0)
  } finally {view.unmount()}
})

test('comparison download retires immediately when its pair is cleared during URL creation',async()=>{
  const view=await mountReportFiles()
  try {
    await acceptFile(view,report());await view.click('capture-left'); const clear=action(view,'comparison-clear')
    view.downloadHooks.create=()=>{delete view.downloadHooks.create;invoke(clear)}
    await view.click('comparison-left-download')
    assert.equal(view.byId('comparison-left-text'),undefined)
    assert.equal(view.downloads.length,0,'A retired comparison must not click a download')
    assert.equal(view.blobs.size,0,'A URL returned after retirement must be revoked immediately')
  } finally {view.unmount()}
})

async function liveReport(view,value) {
  await view.navigate(`/reports?report_id=${value.report_id}`)
  const call=view.requests.calls.getSavedReport.at(-1);call.resolve(ok(value));await flush()
}
for(const cacheHandlers of [true,false]) test(`live JSON and Markdown handlers own exact accepted observation (${cacheHandlers})`,async()=>{
  const view=await mountReportFiles({initialPath:'/reports?report_id=report_A',cacheHandlers})
  try {
    const a=report(),b=report('report_B','B body')
    view.requests.calls.getSavedReport[0].resolve(ok(a));await flush()
    const staleJson=action(view,'download-observation'),staleMarkdown=action(view,'download')
    await liveReport(view,b);await liveReport(view,{...a,markdown_content:'new A',content_bytes:5})
    invoke(staleJson);invoke(staleMarkdown);await flush();assert.equal(view.downloads.length,0)
    await view.click('download-observation');assert.equal(JSON.parse(await view.downloads.at(-1).blob.text()).observation.markdown_content,'new A')
    await view.click('download');assert.equal(await view.downloads.at(-1).blob.text(),'new A');assert.equal(view.blobs.size,1)
    await view.input('search-phrase','retired');assert.equal(view.blobs.size,0)
    const count=view.downloads.length;invoke(staleJson);await view.navigate('/report-files');invoke(staleMarkdown);await flush();assert.equal(view.downloads.length,count)
  } finally {view.unmount()}
})
for(const stage of ['beforeCreate','beforeAnchor','append','click','remove']) test(`live exporter ${stage} failure keeps detail while releasing only its resources`,async()=>{
  const view=await mountReportFiles({initialPath:'/reports?report_id=report_A'})
  try {
    view.requests.calls.getSavedReport[0].resolve(ok(report()));await flush()
    view.downloadHooks[stage]=()=>{throw Error('private download failure')};await view.click('download-observation')
    assert.ok(view.byId('reader'));assert.ok(view.byId('download-error'));assert.equal(view.blobs.size,0);assert.ok(view.anchors.every(a=>!a.attached));assert.doesNotMatch(view.text(),/private download failure/)
  }finally{view.unmount()}
})
for(const stage of ['create','anchor','append','click','remove','revoke']) test(`live reentrant ${stage} export preserves the later owner`,async()=>{
  const view=await mountReportFiles({initialPath:'/reports?report_id=report_A'})
  try{
    view.requests.calls.getSavedReport[0].resolve(ok(report()));await flush();const download=action(view,'download-observation')
    if(stage==='revoke')await view.click('download-observation')
    view.downloadHooks[stage]=()=>{delete view.downloadHooks[stage];invoke(download)};await view.click('download-observation')
    assert.equal(view.blobs.size,1);assert.ok(!view.revokedUrls.includes([...view.blobs.keys()][0]));assert.ok(view.anchors.every(a=>!a.attached))
    await view.input('search-phrase','retire');assert.equal(view.blobs.size,0)
  }finally{view.unmount()}
})
for(const stage of ['create','anchor','append','click','remove']) test(`live reentrant ${stage} reader retirement stops its exporter`,async()=>{
  const view=await mountReportFiles({initialPath:'/reports?report_id=report_A'})
  try{
    view.requests.calls.getSavedReport[0].resolve(ok(report()));await flush();const edit=view.byId('search-phrase').props.onInput
    view.downloadHooks[stage]=()=>{delete view.downloadHooks[stage];edit({target:{value:'retire'}})};await view.click('download-observation')
    assert.equal(view.byId('reader'),undefined);assert.equal(view.blobs.size,0);assert.ok(view.anchors.every(a=>!a.attached))
  }finally{view.unmount()}
})

for(const [name,invalid] of [
  ['size',f=>({...f,size:16*1024*1024+257})],['missing reader',f=>({...f,arrayBuffer:undefined})],
  ['filename length',f=>({...f,name:'x'.repeat(513)})],['nontext filename',f=>({...f,name:null})],
])test(`invalid ${name} leaves accepted report and captures intact without reading`,async()=>{
  const view=await mountReportFiles()
  try{await acceptFile(view,report());await view.click('capture-left');let reads=0;const {pending}=await chooseFile(view,invalid(file(report('B'),'B.json',{arrayBuffer(){reads++;throw Error('private')}})));await pending;await flush();assert.equal(reads,0);assert.ok(view.byId('file-error'));accepted(view,'report_A');assert.ok(view.byId('comparison-left-text'));noEffects(view)}finally{view.unmount()}
})

test('file route imports no API or persistence and metadata makes no content-derived links',async()=>{
  const {readFileSync}=await import('node:fs'); const source=readFileSync(new URL('../src/views/SavedReportFilesView.vue',import.meta.url),'utf8')
  assert.doesNotMatch(source,/from ['"][^'"]*\/api\/|localStorage|sessionStorage|indexedDB|fetch\(|v-html/)
  const view=await mountReportFiles()
  try{const value=report();value.simulation_id='https://private.example';await acceptFile(view,value);assert.ok(view.all(n=>n.type==='a').every(n=>['/','/reports'].includes(n.props.href)));assert.match(view.text(),/historical local observation/i);assert.match(view.text(),/Pinned comparison slots remain/);noEffects(view)}finally{view.unmount()}
})

for(const mutation of ['comparison-clear','comparison-swap','comparison-left-clear','capture-left','unmount']) for(const stage of ['create','anchor','append','click'])test(`comparison ${mutation} at ${stage} retires exact download resources`,async()=>{
  const view=await mountReportFiles()
  try{
    await acceptFile(view,report());await view.click('capture-left');await view.click('capture-right')
    const retire=mutation==='unmount'?()=>view.unmount():action(view,mutation)
    view.downloadHooks[stage]=()=>{delete view.downloadHooks[stage];invoke(retire)};await view.click('comparison-left-download')
    assert.equal(view.blobs.size,0);assert.ok(view.anchors.every(a=>!a.attached));assert.equal(view.timers.pending.size,0)
    if(stage!=='click')assert.equal(view.downloads.length,0)
  }finally{if(mutation!=='unmount')view.unmount()}
})
for(const stage of ['create','anchor','append','click','remove','revoke'])test(`comparison reentrant ${stage} export retains newer resources until its own cleanup`,async()=>{
  const view=await mountReportFiles()
  try{
    await acceptFile(view,report());await view.click('capture-left');const download=action(view,'comparison-left-download')
    if(stage==='revoke')await view.click('comparison-left-download')
    const oldTimers=[...view.timers.pending.values()].map(t=>t.callback)
    view.downloadHooks[stage]=()=>{delete view.downloadHooks[stage];invoke(download)};await view.click('comparison-left-download')
    assert.equal(view.blobs.size,1);assert.ok(!view.revokedUrls.includes([...view.blobs.keys()][0]));assert.ok(view.anchors.every(a=>!a.attached))
    oldTimers.forEach(fn=>fn());await flush();assert.equal(view.blobs.size,1)
    await view.timers.advance(1000);assert.equal(view.blobs.size,0);assert.equal(view.timers.pending.size,0)
  }finally{view.unmount()}
})
for(const stage of ['beforeCreate','beforeAnchor','append','click','remove'])test(`comparison ${stage} failure keeps captures and cleans resources without leaking the error`,async()=>{
  const view=await mountReportFiles()
  try{await acceptFile(view,report());await view.click('capture-left');view.downloadHooks[stage]=()=>{throw Error('private download failure')};await view.click('comparison-left-download');assert.equal(view.blobs.size,0);assert.ok(view.anchors.every(a=>!a.attached));assert.ok(view.byId('comparison-left-text'));assert.deepEqual(view.warnings,[])}finally{view.unmount()}
})

test('opening replacement synchronously retires old reader actions before child props render',async()=>{
  const view=await mountReportFiles()
  try{
    const a=report(),b=report('report_A','new body')
    await acceptFile(view,a);await view.input('report-find','needle')
    const input=view.byId('report-find').props.onInput,next=action(view,'report-find-next'),capture=action(view,'capture-left')
    await previewFile(view,b);const open=action(view,'open-file');invoke(open)
    input({target:{value:'retired'}});invoke(next);invoke(capture);await flush()
    assert.equal(view.byId('report-find').props.value,'');assert.equal(view.byId('comparison-left-text'),undefined);assert.equal(view.text(view.byId('markdown')),b.markdown_content)
  }finally{view.unmount()}
})

test('route commit retires captured comparison callbacks before the next component render',async()=>{
  const {watch}=await import('vue'),view=await mountReportFiles()
  let stop
  try{
    await acceptFile(view,report());await view.click('capture-left');const download=action(view,'comparison-left-download')
    stop=watch(()=>view.router.currentRoute.value.fullPath,()=>invoke(download),{flush:'sync'})
    await view.navigate('/report-files?departed=1')
    assert.equal(view.downloads.length,0,'A departed comparison must not start a download before its queued unmount')
    assert.equal(view.blobs.size,0)
    stop();stop=null
    await acceptFile(view,report('new_session'));await view.click('capture-left');await view.click('clear-file');await view.click('comparison-left-download')
    assert.equal(view.downloads.length,1);assert.equal(await view.downloads[0].blob.text(),report('new_session').markdown_content)
  }finally{stop?.();view.unmount()}
})
