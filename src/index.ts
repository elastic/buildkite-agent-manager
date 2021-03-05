require('dotenv').config();

import bootstrapSecrets from './bootstrapGcpSecrets';
import logger from './lib/logger';
import { run } from './manager';

const TIME_BETWEEN_RUNS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  if (process.env.BOOTSTRAP_GCP_SECRETS) {
    await bootstrapSecrets();
  }

  if (process.env.DRY_RUN) {
  }

  if (process.env.CONTINUOUS_MODE === 'true') {
    const doRun = async () => {
      try {
        await run();
      } catch (ex) {
        console.error(ex);
      }

      await sleep(TIME_BETWEEN_RUNS);
      doRun();
    };

    doRun();
    logger.info('App started');
  } else {
    try {
      await run();
      process.exit(0);
    } catch (ex) {
      console.error(ex);
      process.exit(1);
    }
  }
})();
