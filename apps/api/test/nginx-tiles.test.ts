import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('Nginx rejects every legacy versioned tile route', {
  skip: !process.env.TEST_NGINX_DOCKER,
}, async () => {
  const docker = process.env.DOCKER_BIN ?? 'docker';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maris-nginx-'));
  let container = '';
  try {
    const template = await readFile(new URL('../../../ops/nginx/default.conf.template', import.meta.url), 'utf8');
    await writeFile(path.join(directory,'nginx.conf'), `events {}\nhttp { ${template.replace('${PUBLIC_PORT}','8080')} }`);
    container = execFileSync(docker,['run','--rm','-d','-p','127.0.0.1::8080','-v',`${directory}:/app/.storage:ro`,'-v',`${directory}/nginx.conf:/etc/nginx/nginx.conf:ro`,'nginx:stable-alpine'],{encoding:'utf8'}).trim();
    const address = execFileSync(docker,['port',container,'8080'],{encoding:'utf8'}).trim();
    const get = (suffix:string) => fetch(`http://${address}/tiles/soundg/${suffix}`);
    let ready = false;
    for (let i=0;i<30&&!ready;i++) {
      try { await get('v1/14/4543/6976.pbf'); ready=true; }
      catch { await new Promise(resolve=>setTimeout(resolve,100)); }
    }
    assert.ok(ready);
    for (const suffix of ['v1/14/4543/6976.pbf','v1/14/4543/6977.pbf','missing/14/4543/6977.pbf','v1/17/1/1.pbf','v1/bad']) {
      const missing=await get(suffix);
      assert.equal(missing.status,404);
      assert.equal(missing.headers.get('cache-control'),'no-store');
    }
  } finally {
    if(container) execFileSync(docker,['stop',container],{stdio:'ignore'});
    await rm(directory,{recursive:true,force:true});
  }
});
