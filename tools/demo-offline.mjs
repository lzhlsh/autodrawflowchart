// Exercise every offline edit phrasing, each in its OWN session.
//
// Sequencing matters: running edits in one session lets an earlier rename or
// delete change the anchor node a later edit needs, which looks like a parser
// bug when it is really test contamination.
//
// Usage: node tools/debug-edits.mjs [url]
const BASE = process.argv[2] ?? 'http://127.0.0.1:5188';

const post = async (body) =>
  (
    await fetch(`${BASE}/api/chart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

const CREATE = '画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，结束';

const labelsOf = (xml) =>
  [...xml.matchAll(/value="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((v) => v && v.length < 40 && !v.startsWith('<'));

const cases = [
  '在「输入账号密码」和「校验格式」之间加上「人机验证」',
  '添加一个风控校验',
  '把「校验格式」改成「校验手机号格式」',
  '删除「查询用户是否存在」',
  '改成浅色主题',
  '把布局改成从左到右',
  '改成思维导图布局',
];

let changed = 0;
for (const message of cases) {
  const created = await post({ message: CREATE });
  const edited = await post({ sessionId: created.sessionId, message });
  const applied = edited.xml !== created.xml;
  if (applied) changed += 1;

  console.log(`${message}`);
  console.log(
    `   ${applied ? 'APPLIED' : 'NO-OP  '}  nodes ${created.summary.nodes}->${edited.summary.nodes}` +
      `  theme=${edited.spec?.theme} dir=${edited.spec?.direction} layout=${edited.spec?.layout}`,
  );
  console.log(`   reply : ${String(edited.reply).replace(/（离线模式[\s\S]*$/, '').trim().split('\n')[0]}`);
  console.log(`   labels: ${labelsOf(edited.xml).join(' | ')}`);
  console.log('');
}

console.log(`${changed}/${cases.length} edits changed the diagram`);

// An unsupported edit must preserve the user's diagram, not regenerate it.
// Compare the graph (nodes/labels/edges), not raw XML: a re-compile can differ
// in incidental whitespace even when nothing changed semantically.
const c = await post({ message: CREATE });
const u = await post({ sessionId: c.sessionId, message: '帮我把这张图重新设计得更专业一点' });
const sameGraph =
  c.summary.nodes === u.summary.nodes &&
  c.summary.edges === u.summary.edges &&
  labelsOf(c.xml).join('|') === labelsOf(u.xml).join('|');

console.log(
  `\nunsupported edit preserved the diagram: ${sameGraph}` +
    ` (nodes ${c.summary.nodes} -> ${u.summary.nodes}, edges ${c.summary.edges} -> ${u.summary.edges})`,
);
console.log(`   reply: ${String(u.reply).split('\n')[0]}`);
