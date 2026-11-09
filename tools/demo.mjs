// Show a real generated diagram so the output can be eyeballed.
// Usage: node tools/demo.mjs [url]
const BASE = process.argv[2] ?? 'http://127.0.0.1:5188';

const res = await fetch(`${BASE}/api/chart`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message:
      '画一个电商下单支付流程图：用户提交订单，校验库存，判断库存是否充足，充足则创建支付单，调用支付网关，判断支付是否成功，成功则更新订单状态并通知用户发货，失败则取消订单并退款，库存不足则提示补货',
  }),
});
const body = await res.json();

console.log('provider :', body.provider, `(${body.providerReason})`);
console.log('latency  :', body.latencyMs, 'ms');
console.log('reply    :', body.reply);
console.log('summary  :', JSON.stringify(body.summary));
console.log('warnings :', JSON.stringify(body.warnings));
console.log('suggest  :', JSON.stringify(body.suggestions));
console.log('\n--- draw.io XML ---\n');
console.log(body.xml);
