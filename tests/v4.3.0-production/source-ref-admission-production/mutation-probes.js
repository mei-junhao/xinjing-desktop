'use strict';

const suite = require('./run-contract.js');

async function expectKilled(id, sources) {
  const result = await suite.runSuite(sources);
  const killed = result.failed > 0;
  console.log('[' + (killed ? 'PASS' : 'FAIL') + '] ' + id + ': ' + (killed ? 'mutation killed' : 'mutation survived'));
  return killed;
}

(async () => {
  const results = [];
  results.push(await expectKilled('M1-quarantine-bypass', {
    viewModel: suite.defaultSources.viewModel.replace('if (quarantinedIds.has(String(material.id)))', 'if (false)')
  }));
  results.push(await expectKilled('M2-source-change-bypass', {
    sourceRef: suite.defaultSources.sourceRef.replace('if (!result.verified)', 'if (false)')
  }));
  results.push(await expectKilled('M3-refresh-order-bypass', {
    viewModel: suite.defaultSources.viewModel.replace('if (refreshId !== latestRefreshId)', 'if (false)')
  }));
  const passed = results.filter(Boolean).length;
  console.log('Killed: ' + passed + ' | Survived: ' + (results.length - passed));
  process.exit(passed === results.length ? 0 : 1);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
