import { createServer } from 'node:http'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const echo = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ url: request.url, mapped: request.headers['x-mapped'], body: Buffer.concat(chunks).toString('utf8') }))
})

await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
try {
  const address = echo.address()
  if (!address || typeof address === 'string') throw new Error('Echo server did not expose a TCP port')
  const input = JSON.stringify({ user: { id: 'live-42', name: '小明 "DSH"\n第二行' }, count: 3 })
  const response = await fetch(`${baseUrl}/dsh-node-flow/node-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({
      node: {
        id: 'live-mapper-http',
        type: 'workflow',
        position: { x: 0, y: 0 },
        data: {
          kind: 'http',
          label: 'Live mapper HTTP',
          httpMethod: 'POST',
          url: `http://127.0.0.1:${address.port}/echo?id={{result.user.id}}`,
          headers: '{"content-type":"application/json","x-mapped":"{{result.user.id}}"}',
          body: '{"name":"{{result.user.name}}","count":{{result.count}}}',
          responseMode: 'json',
          failOnHttpError: true,
        },
      },
      input,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.node?.status !== 'ok') throw new Error(data.error || data.node?.error || `HTTP ${response.status}`)
  const output = data.node.output
  const body = JSON.parse(output.body)
  if (output.url !== '/echo?id=live-42' || output.mapped !== 'live-42' || body.name !== '小明 "DSH"\n第二行' || body.count !== 3) {
    throw new Error(`Unexpected mapped output: ${JSON.stringify(output)}`)
  }
  console.log(JSON.stringify({ ok: true, nestedPath: true, jsonEscaping: true }, null, 2))
} finally {
  await new Promise((resolve, reject) => echo.close((error) => error ? reject(error) : resolve()))
}
