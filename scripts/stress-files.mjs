// File-manager stress test against a running panel.
// Usage: node scripts/stress-files.mjs [base] [pin] [--limiter]
// Reports throughput, latency, integrity and where the limits actually sit.
// --limiter alone measures the rate-limit ceiling; it deliberately trips the bucket, so it
// must not share a run with the upload phases (their cleanup needs the API).
import fs from 'node:fs';
import path from 'node:path';

const positionals = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const BASE = positionals[0] || 'http://127.0.0.1:3000';
const PIN = positionals[1] || '1234';
const DATA_DIR = path.resolve('data/pb_public');
const SERVER_PID = Number(fs.readFileSync('/tmp/server.pid', 'utf8').trim());

const KiB = 1024;
const MiB = 1024 * KiB;

let token = '';
const stats = { requests: 0, byStatus: {} };

function rssMiB() {
  try {
    const status = fs.readFileSync(`/proc/${SERVER_PID}/status`, 'utf8');
    const match = status.match(/VmRSS:\s+(\d+) kB/);
    return match ? Number(match[1]) / 1024 : NaN;
  } catch {
    return NaN;
  }
}

function diskMiB() {
  let total = 0;
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('.')) total += fs.statSync(path.join(DATA_DIR, entry.name)).size;
  }
  return total / MiB;
}

async function call(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers['X-Pocket-Token'] = token;
  const started = performance.now();
  const response = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const ms = performance.now() - started;
  stats.requests += 1;
  stats.byStatus[response.status] = (stats.byStatus[response.status] || 0) + 1;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, ms, retryAfter: response.headers.get('retry-after') };
}

function makeFile(index, bytes, prefix) {
  return { name: `${prefix}-${String(index).padStart(4, '0')}.bin`, buffer: Buffer.alloc(bytes, (index % 250) + 1) };
}

async function upload(files) {
  const form = new FormData();
  for (const file of files) {
    form.append('files', new Blob([file.buffer]), file.name);
  }
  return call('/api/upload', { method: 'POST', body: form });
}

const pct = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function runPool(workerCount, taskCount, task) {
  const latencies = [];
  let index = 0;
  let failures = 0;
  const started = performance.now();

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < taskCount) {
        const current = index;
        index += 1;
        const result = await task(current);
        latencies.push(result.ms);
        if (result.status !== 200) failures += 1;
      }
    }),
  );

  const seconds = (performance.now() - started) / 1000;
  return { workerCount, taskCount, seconds, failures, p50: pct(latencies, 50), p95: pct(latencies, 95) };
}

async function main() {
  const start = await call('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  if (start.status !== 200 || !start.body?.token) {
    console.error(`login failed: ${start.status} ${JSON.stringify(start.body)}`);
    process.exit(1);
  }
  token = start.body.token;

  const baseline = (await call('/api/files')).body;

  if (process.argv.slice(2).includes('--limiter')) {
    let served = 0;
    for (let index = 0; index < 400; index += 1) {
      const probe = await call('/api/health');
      if (probe.status === 429) break;
      served += 1;
    }
    console.log(`rate limit: ${served} /api calls served on an idle bucket, then HTTP 429 (limit is 240 per 60s per client)`);
    console.log(`status histogram: ${JSON.stringify(stats.byStatus)}`);
    return;
  }
  const baselineNames = new Set(baseline.files.map((file) => file.name));
  const rssBefore = rssMiB();
  const diskBefore = diskMiB();
  console.log(`baseline: ${baseline.files.length} files, ${diskBefore.toFixed(1)} MiB on disk, server RSS ${rssBefore.toFixed(1)} MiB`);
  console.log('');

  /* ---- Phase 1: burst of parallel multi-file uploads ---- */
  const BATCHES = 50;
  const PER_BATCH = 8;
  const FILE_BYTES = 128 * KiB;
  const burst = await runPool(BATCHES, BATCHES, (index) =>
    upload(Array.from({ length: PER_BATCH }, (_, offset) => makeFile(index * PER_BATCH + offset, FILE_BYTES, 'stress-a'))),
  );
  const burstMiB = (BATCHES * PER_BATCH * FILE_BYTES) / MiB;
  console.log(
    `phase 1 burst: ${BATCHES} requests x ${PER_BATCH} files x ${FILE_BYTES / KiB} KiB = ` +
      `${BATCHES * PER_BATCH} files / ${burstMiB.toFixed(0)} MiB in ${burst.seconds.toFixed(2)}s ` +
      `(${(burstMiB / burst.seconds).toFixed(1)} MiB/s, p50 ${burst.p50.toFixed(0)} ms, p95 ${burst.p95.toFixed(0)} ms, failures ${burst.failures})`,
  );

  const afterBurst = (await call('/api/files')).body;
  const expected = baseline.files.length + BATCHES * PER_BATCH;
  console.log(`integrity: listed ${afterBurst.files.length} files, expected ${expected} — ${afterBurst.files.length === expected ? 'MATCH' : 'MISMATCH'}`);
  console.log(`disk ${diskMiB().toFixed(1)} MiB, server RSS ${rssMiB().toFixed(1)} MiB`);
  console.log('');

  /* ---- Phase 2: concurrency ladder, one 512 KiB file per request ---- */
  console.log('phase 2 concurrency ladder (20 requests each, 512 KiB per request):');
  for (const workers of [1, 4, 8, 16]) {
    const level = await runPool(workers, 20, (index) => upload([makeFile(index, 512 * KiB, `stress-b${workers}`)]));
    const mib = (20 * 512 * KiB) / MiB;
    console.log(
      `  ${String(workers).padStart(2)} workers: ${level.seconds.toFixed(2)}s, ${(level.taskCount / level.seconds).toFixed(1)} req/s, ` +
        `${(mib / level.seconds).toFixed(1)} MiB/s, p50 ${level.p50.toFixed(0)} ms, p95 ${level.p95.toFixed(0)} ms, failures ${level.failures}`,
    );
  }
  console.log('');

  /* ---- Phase 3: limits and abuse ---- */
  console.log('phase 3 limits and abuse:');
  const tooMany = await upload(Array.from({ length: 21 }, (_, index) => makeFile(index, 1 * KiB, 'stress-c')));
  console.log(`  21 files in one request → ${tooMany.status} ${tooMany.body?.error || ''}`);

  const traversal = await call('/api/files/..%2F..%2F..%2Fetc%2Fpasswd');
  console.log(`  GET traversal name → ${traversal.status}`);

  const missing = await call('/api/files/does-not-exist.bin');
  console.log(`  DELETE missing file → ${missing.status}`);

  const renameConflict = await call(`/api/files/${encodeURIComponent(afterBurst.files[0].name)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: afterBurst.files[1].name }),
  });
  console.log(`  rename onto an existing name → ${renameConflict.status}`);

  const unauthed = await fetch(`${BASE}/api/files`);
  console.log(`  GET /api/files without token → ${unauthed.status}`);
  console.log('');

  /* ---- Cleanup: delete what the API will take, then the rest from disk ---- */
  const listed = (await call('/api/files')).body?.files || [];
  const all = listed.filter((file) => file.name.startsWith('stress-'));
  let deleted = 0;
  let blocked = 0;
  for (const file of all) {
    const result = await call(`/api/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
    if (result.status === 200) deleted += 1;
    else blocked += 1;
    if (blocked > 20) break;
  }
  console.log(`cleanup: deleted ${deleted} test files over the API, ${blocked} refused (rate limit)`);

  for (const entry of fs.readdirSync(DATA_DIR)) {
    if (entry.startsWith('stress-')) fs.unlinkSync(path.join(DATA_DIR, entry));
  }
  const listedFinal = await call('/api/files');
  const final = listedFinal.body?.files || [];
  const onDisk = fs.readdirSync(DATA_DIR).filter((name) => !name.startsWith('.'));
  const leftovers = onDisk.filter((name) => name.startsWith('stress-') || name.startsWith('attrib-')).length;
  console.log(
    `final: ${listedFinal.status === 200 ? final.length : `listing refused (HTTP ${listedFinal.status})`} files, ` +
      `baseline ${baselineNames.size}, on disk ${onDisk.length}, test leftovers ${leftovers}, ` +
      `disk ${diskMiB().toFixed(1)} MiB, server RSS ${rssMiB().toFixed(1)} MiB`,
  );

  const restored = leftovers === 0 && onDisk.length === baselineNames.size && (listedFinal.status !== 200 || final.length === baselineNames.size);
  if (!restored) {
    console.error('cleanup did not restore the baseline');
    process.exit(1);
  }
  console.log('cleanup restored the baseline');
  console.log('');
  console.log(`status histogram: ${JSON.stringify(stats.byStatus)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
