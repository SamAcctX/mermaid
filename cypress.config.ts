import eyesPlugin from '@applitools/eyes-cypress';
import { registerArgosTask } from '@argos-ci/cypress/task';
import coverage from '@cypress/code-coverage/task.js';
import { defineConfig } from 'cypress';
import { addMatchImageSnapshotPlugin } from 'cypress-image-snapshot/plugin.js';
import cypressSplit from 'cypress-split';
import 'dotenv/config';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export default eyesPlugin(
  defineConfig({
    projectId: 'n2sma2',
    viewportWidth: 1440,
    viewportHeight: 1024,
    e2e: {
      baseUrl: `http://localhost:${process.env.MERMAID_PORT ?? 9000}`,
      specPattern: 'cypress/integration/**/*.{js,ts}',
      setupNodeEvents(on, config) {
        coverage(on, config);
        cypressSplit(on, config);
        on('before:browser:launch', (browser, launchOptions) => {
          if (browser.name === 'chrome' && browser.isHeadless) {
            launchOptions.args.push('--window-size=1440,1024', '--force-device-scale-factor=1');
          }
          return launchOptions;
        });
        // copy any needed variables from process.env to config.env
        config.env.useAppli = process.env.USE_APPLI ? true : false;
        config.env.useArgos = process.env.RUN_VISUAL_TEST === 'true';

        if (config.env.useArgos) {
          // Capture only. Screenshots are written to cypress/screenshots and
          // uploaded later by the `argos-batch` CI job, which composites them
          // into folder-wise sheets. Subset handling moves to `argos upload`.
          registerArgosTask(on, config, {
            uploadToArgos: false,
          });
        } else {
          addMatchImageSnapshotPlugin(on, config);
        }
        on('task', {
          listSwimlaneFixtures() {
            return readdirSync(
              join(config.projectRoot, 'cypress/platform/dev-diagrams/layout-tests/swimlanes')
            )
              .filter((file) => file.endsWith('.mmd'))
              .sort();
          },
        });
        // do not forget to return the changed config object!
        return config;
      },
    },
    video: false,
  })
);
