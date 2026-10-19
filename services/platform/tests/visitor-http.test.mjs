import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {A,resetDatabase,grantBaseline,makeSession,adminQuery,closeAll} from './harness.mjs'
import {publishVisitorFixture} from './visitor-fixture.mjs'
import {issueLink} from '../src/visitor.mjs'
import {isOwnedPath} from '../src/proxy.mjs'
let issuer,platform,exited,upstream,origin,proxied=0
before(async()=>{
  await resetDatabase();await grantBaseline(A.alice);await publishVisitorFixture();issuer=await makeSession(A.alice,A.company)
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')
  upstream=createServer((_req,res)=>{proxied++;res.writeHead(418);res.end('unexpected runtime route')})
  upstream.on('upgrade',(_req,socket)=>{proxied++;socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')})
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));origin=`http://127.0.0.1:${port}`
  platform=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
    env:{...process.env,KVVI_INTERNAL_TOKEN:'owned-visitor-http-context-fixture',KVVI_PLATFORM_HOST:'127.0.0.1',KVVI_PLATFORM_PORT:String(port),KVVI_RUNTIME_URL:`http://127.0.0.1:${upstream.address().port}`},stdio:'ignore'})
  exited=new Promise(resolve=>platform.once('exit',resolve))
  const deadline=Date.now()+10000
  while(Date.now()<deadline){
    assert.equal(platform.exitCode,null,'owned platform exited during startup')
    try{if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(1000)})).ok)return}catch{}
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.fail('owned platform did not start')
})
after(async()=>{
  if(platform){
    if(platform.exitCode===null&&platform.signalCode===null)platform.kill('SIGTERM')
    const timer=setTimeout(()=>platform.kill('SIGKILL'),3000)
    try{await exited}finally{clearTimeout(timer)}
  }
  if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))}
  await closeAll()
})
const link=(maxSubmissions=1)=>issueLink({ctx:issuer.ctx,formCode:'general_item',schemaCode:'general_item',fields:['title','amount'],actions:['create'],rowScope:{},maxSubmissions})
const post=(path,body,key=randomUUID(),headers={})=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key,...headers},body:JSON.stringify(body),redirect:'manual'})
test('an anonymous signed-link HTTP request writes under the issuer, with its original key',async()=>{
  const result=await link(),key=randomUUID()
  const response=await post('/visitor/submit',{token:result.token,data:{title:'actual HTTP visitor',amount:7}},key)
  assert.equal(response.status,201)
  const body=await response.json()
  assert.equal(body.idempotencyKey,key);assert.ok(body.recordId)
  const record=(await adminQuery('kvvi_business','SELECT owner_id,data FROM business_records WHERE record_id=$1',[body.recordId])).rows[0]
  assert.equal(record.owner_id,A.alice);assert.equal(record.data.amount,7)
  const recovered=await post('/visitor/receipt',{token:result.token},key)
  assert.equal(recovered.status,200);assert.equal((await recovered.json()).recordId,body.recordId)
})
test('the visitor namespace is owned by platform and exposes no anonymous list or runtime RPC',async()=>{
  assert.equal(isOwnedPath('/visitor/anything'),true)
  const response=await fetch(origin+'/visitor/records',{redirect:'manual'})
  assert.equal(response.status,404);assert.equal(proxied,0)
})
test('missing or invalid original keys are rejected before an effect',async()=>{
  const result=await link()
  for(const key of ['', 'a-new-key-on-every-retry']){
    const response=await post('/visitor/submit',{token:result.token,data:{title:'must not write bad key'}},key)
    assert.equal(response.status,400);assert.equal((await response.json()).error,'KVVI_OPERATION_KEY_INVALID')
  }
})
test('invalid signatures cannot be replaced by a browser account credential',async()=>{
  const response=await post('/visitor/submit',{token:'invalid signed link',data:{title:'must not write invalid token'}},randomUUID(),{
    authorization:'Bearer '+issuer.raw,cookie:'kvvi_session=ignored'})
  assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'KVVI_VISITOR_LINK_INVALID'})
})
test('extra identity/source properties and non-object business data are rejected',async()=>{
  const result=await link()
  for(const extra of [{companyId:A.company},{sourceIp:'203.0.113.8'},{idempotencyKey:randomUUID()}]){
    const response=await post('/visitor/submit',{token:result.token,data:{title:'must not adopt identity'},...extra})
    assert.equal(response.status,400)
  }
  const malformed=await post('/visitor/submit',{token:result.token,data:[]})
  assert.equal(malformed.status,400)
  assert.equal((await malformed.json()).error,'KVVI_RECORD_DATA_INVALID')
})
test('declared native field types are checked by the actual published model',async()=>{
  const result=await link()
  const response=await post('/visitor/submit',{token:result.token,data:{title:'invalid integer',amount:'7'}})
  assert.equal(response.status,400)
  assert.equal((await response.json()).error,'KVVI_FIELD_TYPE_INVALID')
})
test('the same original key resumes one HTTP result and changed data conflicts',async()=>{
  const result=await link(),key=randomUUID(),body={token:result.token,data:{title:'one HTTP original'}}
  const first=await post('/visitor/submit',body,key),original=await first.json()
  assert.equal(first.status,201)
  const replay=await post('/visitor/submit',body,key.toUpperCase())
  assert.equal(replay.status,201);assert.equal((await replay.json()).recordId,original.recordId)
  const changed=await post('/visitor/submit',{...body,data:{title:'changed HTTP original'}},key)
  assert.equal(changed.status,409)
  const conflict=await changed.json();assert.equal(conflict.idempotencyKey,key)
  assert.equal(JSON.stringify(conflict).includes('visitor.v1.'),false)
})
test('max1 concurrent different HTTP keys allow exactly one business creation',async()=>{
  const result=await link()
  const responses=await Promise.all(Array.from({length:6},(_,i)=>post('/visitor/submit',{token:result.token,data:{title:'HTTP race '+i}})))
  assert.equal(responses.filter(response=>response.status===201).length,1)
  assert.equal(responses.filter(response=>response.status===429).length,5)
  await Promise.all(responses.map(response=>response.arrayBuffer()))
})
test('source comes from the actual socket, ignoring forwarded headers and browser session identity',async()=>{
  const result=await link()
  const response=await post('/visitor/submit',{token:result.token,data:{title:'socket source'}},randomUUID(),{
    'x-forwarded-for':'203.0.113.99','x-real-ip':'203.0.113.88',authorization:'Bearer irrelevant',cookie:'kvvi_session=irrelevant'})
  assert.equal(response.status,201);const body=await response.json()
  const stored=(await adminQuery('kvvi_business','SELECT issuer_id,projection_payload FROM visitor_submissions WHERE operation_id=$1',[body.operationId])).rows[0]
  assert.equal(stored.issuer_id,A.alice);assert.equal(stored.projection_payload.sourceIp,'127.0.0.1')
})
test('JSON, body size, query and method boundaries return private uncached JSON',async()=>{
  const result=await link()
  const cases=[
    [await fetch(origin+'/visitor/submit',{method:'POST',body:'plain text'}),415],
    [await fetch(origin+'/visitor/submit',{method:'POST',headers:{'content-type':'application/json'},body:'{bad JSON'}),400],
    [await post('/visitor/submit',{token:result.token,data:{title:'x'.repeat(70000)}}),413],
    [await post('/visitor/submit?forbidden=1',{token:result.token,data:{title:'no query'}}),400],
    [await fetch(origin+'/visitor/receipt',{redirect:'manual'}),405],
  ]
  for(const [response,status] of cases){
    assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store')
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-content-type-options'),'nosniff')
    assert.equal(response.headers.get('set-cookie'),null);assert.match(response.headers.get('content-type'),/^application\/json/)
    await response.arrayBuffer()
  }
})
test('an actual lost HTTP reply is recovered read-only with its original key',async()=>{
  const {request:httpRequest}=await import('node:http'),result=await link(),key=randomUUID()
  let confirmed
  const committed=new Promise(resolve=>{confirmed=resolve})
  const droppingProxy=createServer((req,res)=>{
    const forward=httpRequest(new URL(req.url,origin),{method:req.method,headers:req.headers},reply=>{
      reply.resume();reply.once('end',()=>{confirmed();res.destroy()})
    })
    forward.on('error',()=>{confirmed();res.destroy()});req.pipe(forward)
  })
  await new Promise(resolve=>droppingProxy.listen(0,'127.0.0.1',resolve))
  try{
    await assert.rejects(()=>fetch(`http://127.0.0.1:${droppingProxy.address().port}/visitor/submit`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},
      body:JSON.stringify({token:result.token,data:{title:'lost HTTP reply'}}),signal:AbortSignal.timeout(5000)}))
    await committed
    const response=await post('/visitor/receipt',{token:result.token},key)
    assert.equal(response.status,200);const recovered=await response.json();assert.equal(recovered.state,'COMMITTED')
    assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'='lost HTTP reply'")).rows[0].n,1)
  }finally{droppingProxy.closeAllConnections();await new Promise(resolve=>droppingProxy.close(resolve))}
})
test('an unknown HTTP receipt preserves its caller original key',async()=>{
  const result=await link(),key=randomUUID()
  const response=await post('/visitor/receipt',{token:result.token},key)
  assert.equal(response.status,202)
  assert.deepEqual(await response.json(),{state:'UNKNOWN',idempotencyKey:key,retryWithSameKey:true})
})
test('a closed cutover gate returns unavailable without a business effect',async()=>{
  const result=await link()
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=false WHERE singleton')
  try{
    const response=await post('/visitor/submit',{token:result.token,data:{title:'HTTP cutover must not write'}})
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'KVVI_VISITOR_CUTOVER_REQUIRED'})
    assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'='HTTP cutover must not write'")).rows[0].n,0)
  }finally{await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')}
})

test('malformed token envelopes are invalid credentials rather than internal errors',async()=>{
  for(const header of [null,[],42,'unexpected']){
    const token='v.'+Buffer.from(JSON.stringify(header)).toString('base64url')+'.e30.AA'
    const response=await post('/visitor/submit',{token,data:{title:'must not write malformed envelope'}})
    assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'KVVI_VISITOR_LINK_INVALID'})
  }
})
test('an authenticated raw WebSocket upgrade cannot forward a visitor platform path',async()=>{
  const {connect}=await import('node:net'),{issueBrowserCredential}=await import('../src/identity.mjs')
  const {credential}=await issueBrowserCredential(issuer.session.sessionId)
  const upgrade=path=>new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:Number(new URL(origin).port)})
    let response=''
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('owned upgrade timeout'))},2000)
    socket.on('data',chunk=>{response+=chunk.toString('utf8')})
    socket.once('end',()=>{clearTimeout(timer);socket.destroy();resolve(response)})
    socket.once('error',error=>{clearTimeout(timer);socket.destroy();reject(error)})
    socket.once('connect',()=>socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: kvvi-session=${credential}\r\n\r\n`))
  })
  const before=proxied
  assert.match(await upgrade('/socket'),/^HTTP\/1.1 101/u)
  assert.equal(proxied,before+1,'positive control must authenticate and reach the owned runtime')
  assert.match(await upgrade('/visitor/submit'),/^HTTP\/1.1 404/u)
  assert.equal(proxied,before+1,'visitor upgrade must never reach runtime')
})
