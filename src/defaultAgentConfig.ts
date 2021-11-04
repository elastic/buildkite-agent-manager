import { TopLevelConfig } from './agentConfig';

const defaultConfig: TopLevelConfig = {
  gcp: {
    project: 'elastic-kibana-184716',
    zone: 'us-central1-b',
    // zone: 'us-west1-a',
    serviceAccount: '',
    agents: [],
  },
};

export default defaultConfig;
