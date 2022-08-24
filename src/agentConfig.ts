import { Octokit } from '@octokit/rest';
import axios from 'axios';
import crypto from 'crypto';
import defaultConfig from './defaultConfig';

import { INSTANCE_SUFFIX_BYTES } from './gcp';
import logger from './lib/logger';

let github: Octokit;

let LAST_SUCCESSFUL_CONFIG = null;

export type GcpTopLevelConfig = Partial<GcpAgentConfiguration> & {
  project: string;
  agents: Partial<GcpAgentConfiguration>[];
};

export type TopLevelConfig = {
  gcp: GcpTopLevelConfig;
  pauseAllAgents?: boolean;
};

export type AgentConfiguration = {
  gcp: {
    project: string;
    agents: GcpAgentConfiguration[];
  };
  pauseAllAgents?: boolean;
};

export class GcpAgentConfiguration {
  // can name/queue be merged?
  name: string;
  queue: string;

  project: string;
  // zone Deprecated, use zones
  zone?: string;
  zones?: string[];
  imageFamily?: string;
  image?: string;
  machineType: string;
  subnetwork: string = 'default';
  disableExternalIp?: boolean;
  nestedVirtualization = false;

  serviceAccount?: string;
  serviceAccounts?: string[];

  diskType?: 'pd-ssd' | 'pd-balanced' | 'pd-standard';
  diskSizeGb?: number;
  localSsds?: number;
  startupScript?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  buildPath?: string;

  overprovision?: number;
  minimumAgents?: number;
  maximumAgents?: number;

  idleTimeoutMins?: number;
  exitAfterOneJob?: boolean;

  gracefulStopAfterMins?: number;
  hardStopAfterMins?: number;

  spot? = false;

  private zoneBalanceCounter = 0;

  constructor(config: Partial<GcpAgentConfiguration>) {
    const requiredFields = ['name', 'queue', 'project', 'imageFamily', 'machineType'];
    for (const field of requiredFields) {
      if (!config[field]) {
        throw Error(`GCP agent config missing '${field}' field`);
      }
    }

    if (!config.image && !config.imageFamily) {
      throw Error(`GCP agent config must include 'image' or 'imageFamily'`);
    }

    if (!config.zone && !config.zones) {
      throw Error(`GCP agent config must include 'zone' or 'zones'`);
    }

    // 63 is max length for GCP instance names, minus a unique suffix length, minus 1 character for a hyphen
    const maxLength = 63 - INSTANCE_SUFFIX_BYTES * 2 - 1;
    if (config.name.length > maxLength) {
      throw Error(`GCP agent name must be fewer than ${maxLength} characters.`);
    }

    if (config.serviceAccount && !config.serviceAccounts) {
      config.serviceAccounts = [config.serviceAccount];
    }

    if (config.zone && !config.zones?.length) {
      config.zones = [config.zone];
    }

    Object.assign(this, config);
  }

  getNextZone(): string {
    const zone = this.zones[this.zoneBalanceCounter];
    this.zoneBalanceCounter += 1;
    if (this.zoneBalanceCounter >= this.zones.length) {
      this.zoneBalanceCounter = 0;
    }

    return zone;
  }

  // Should return a hash that only changes if a configuration changes that would require launching a new agent
  // We can use this to tag agents with the version of the config that was used to launch them, and drain them if it changes
  hash() {
    const hashFields = [
      'project',
      'zones',
      'image',
      'imageFamily',
      'subnetwork',
      'disableExternalIp',
      'machineType',
      'serviceAccount',
      'diskType',
      'diskSizeGb',
      'localSsds',
      'startupScript',
      'tags',
      'metadata',
      'idleTimeoutSecs',
      'idleTimeoutMins',
      'exitAfterOneJob',
      'nestedVirtualization',
    ];

    const fields = {};
    for (const field of hashFields) {
      fields[field] = this[field];
    }
    const str = JSON.stringify(fields);
    const hash = crypto.createHash('sha256');
    return hash.update(str).digest('hex');
  }
}

export function getAgentConfigsFromTopLevelConfig(config: TopLevelConfig) {
  const allConfigs = { gcp: [] } as { gcp: GcpAgentConfiguration[] };
  const defaultGcpConfigs = { ...config.gcp };
  delete defaultGcpConfigs.agents;

  for (const agent of config.gcp.agents) {
    try {
      const agentConfig = new GcpAgentConfiguration({
        ...defaultGcpConfigs,
        ...agent,
      });
      allConfigs.gcp.push(agentConfig);
    } catch (ex) {
      logger.error(ex);
    }
  }

  return allConfigs;
}

export function getGcpAgentConfigsFromTopLevelConfig(config: TopLevelConfig) {
  const allConfigs: GcpAgentConfiguration[] = [];
  const defaultGcpConfigs = { ...config.gcp };
  delete defaultGcpConfigs.agents;

  for (const agent of config.gcp.agents) {
    try {
      const agentConfig = new GcpAgentConfiguration({
        ...defaultGcpConfigs,
        ...agent,
      });
      allConfigs.push(agentConfig);
    } catch (ex) {
      logger.error(ex);
    }
  }

  return allConfigs;
}

export async function getConfig() {
  let remoteConfig: TopLevelConfig = null;

  try {
    const request = {
      owner: defaultConfig.repoOwner,
      repo: defaultConfig.repoName,
      ref: defaultConfig.configBranch,
      path: defaultConfig.configPath || '.ci/buildkite-agents.json',
    };

    logger.info(`[github] Fetching remote agent config from ${request.owner}/${request.repo}#${request.ref}:${request.path}`);

    github =
      github ??
      new Octokit({
        auth: process.env.GITHUB_TOKEN,
      });

    const { data } = await github.repos.getContent(request);
    const json = Buffer.from((data as any).content, 'base64').toString();
    remoteConfig = JSON.parse(json);

    LAST_SUCCESSFUL_CONFIG = remoteConfig;
  } catch (ex) {
    remoteConfig = LAST_SUCCESSFUL_CONFIG;
    logger.error('[github] Error fetching remote agent config, using last successful config if possible');
    logger.error(ex);
  }

  logger.info(`[github] Done fetching remote agent config`);

  if (!remoteConfig) {
    throw Error("Couldn't fetch agent configuration");
  }

  return getConfigWithAgents(remoteConfig);
}

export function getConfigWithAgents(config: TopLevelConfig): AgentConfiguration {
  return {
    gcp: {
      ...config.gcp,
      agents: getGcpAgentConfigsFromTopLevelConfig(config),
    },
    pauseAllAgents: !!config.pauseAllAgents,
  };
}

export async function getAgentConfigs() {
  const conf = await getConfig();
  return getAgentConfigsFromTopLevelConfig(conf);
}
