import monitoring from '@google-cloud/monitoring';
import { GcpAgentConfiguration } from './agentConfig';

import { globalCache } from './cache';
import logger from './lib/logger';

const client = new monitoring.MetricServiceClient();

export type MetricsResult = Record<string, number>;
export type ZoneScores = Record<string, number>;
export type ZoneWeighting = Record<string, number>;
export type MetricsResults = {
  results: MetricsResult;
  resultsByMachineFamily: Record<string, MetricsResult>;
};

// The listed regions here are much cheaper than all of the other regions
// So let's weight all other regions so that we use them less often
const DEFAULT_REGION_SCORE = 5;
export const DEFAULT_REGION_SCORES = {
  'northamerica-northeast2': 0,
  'europe-west2': 0,
  'southamerica-east1': 0,
  'asia-south2': 0,
};

const DEFAULT_PREEMPTION_WINDOW_MINUTES = 60;
// Zones with this many preemptions in the current window will get filtered out completely
// However, if too many zones get filtered out, a failsafe will still allow the best 3 zones to be used
const MAX_PREEMPTIONS_PER_WINDOW = 10;

export async function getLoggingMetricsWithCache(
  gcpAgentConfigs: GcpAgentConfiguration[],
  projectId: string,
  metricType: string,
  sinceNumberOfMinutes: number = DEFAULT_PREEMPTION_WINDOW_MINUTES
): Promise<MetricsResults> {
  const cacheKey = `${metricType}-${projectId}-${sinceNumberOfMinutes}`;
  let metrics: MetricsResults;
  try {
    metrics = await getLoggingMetrics(gcpAgentConfigs, projectId, metricType, sinceNumberOfMinutes);
    globalCache.set(cacheKey, metrics, 60 * 10);
  } catch (ex: any) {
    console.error(ex.toString());
  }

  return metrics ?? globalCache.get(cacheKey);
}

export async function getLoggingMetrics(
  gcpAgentConfigs: GcpAgentConfiguration[],
  projectId: string,
  metricType: string,
  sinceNumberOfMinutes: number = DEFAULT_PREEMPTION_WINDOW_MINUTES
): Promise<MetricsResults> {
  const filter = `metric.type="logging.googleapis.com/user/${metricType}"`;

  const request = {
    name: client.projectPath(projectId),
    filter: filter,
    interval: {
      startTime: {
        seconds: Date.now() / 1000 - 60 * sinceNumberOfMinutes,
      },
      endTime: {
        seconds: Date.now() / 1000,
      },
    },
  };

  const [timeSeries] = await client.listTimeSeries(request);
  const results: MetricsResult = {};
  const resultsByMachineFamily: Record<string, MetricsResult> = {};

  timeSeries.forEach((data) => {
    const zone = data.resource.labels.zone;

    results[zone] = results[zone] ?? 0;
    results[zone] += 1;

    const instanceName = data.metric.labels.resourceName.substring(data.metric.labels.resourceName.lastIndexOf('/') + 1);
    const baseName = instanceName.substring(0, instanceName.lastIndexOf('-'));
    const config = gcpAgentConfigs.find((c) => c.name === baseName);
    if (config) {
      const cpuType = config.machineType.substring(0, config.machineType.indexOf('-'));
      resultsByMachineFamily[cpuType] = resultsByMachineFamily[cpuType] ?? {};
      resultsByMachineFamily[cpuType][zone] = resultsByMachineFamily[cpuType][zone] ?? 0;
      resultsByMachineFamily[cpuType][zone] += 1;
    }
  });

  return {
    results,
    resultsByMachineFamily,
  };
}

export async function getPreemptionsWithCache(
  gcpAgentConfigs: GcpAgentConfiguration[],
  projectId: string,
  sinceNumberOfMinutes: number = DEFAULT_PREEMPTION_WINDOW_MINUTES
): Promise<MetricsResults> {
  logger.info('[gcp] Getting preemption metrics');
  const data = await getLoggingMetricsWithCache(gcpAgentConfigs, projectId, 'instance-preemptions', sinceNumberOfMinutes);
  logger.info('[gcp] Finishing getting preemption metrics');
  return data;
}

export async function getPreemptions(
  gcpAgentConfigs: GcpAgentConfiguration[],
  projectId: string,
  sinceNumberOfMinutes: number = DEFAULT_PREEMPTION_WINDOW_MINUTES
) {
  return getLoggingMetrics(gcpAgentConfigs, projectId, 'instance-preemptions', sinceNumberOfMinutes);
}

export async function getResourceExhaustionsWithCache(
  gcpAgentConfigs: GcpAgentConfiguration[],
  projectId: string,
  sinceNumberOfMinutes: number = DEFAULT_PREEMPTION_WINDOW_MINUTES
): Promise<MetricsResults> {
  logger.info('[gcp] Getting resource exhaustion metrics');
  const data = await getLoggingMetricsWithCache(gcpAgentConfigs, projectId, 'instance-resource-exhausted', sinceNumberOfMinutes);
  logger.info('[gcp] Finished getting resource exhaustion metrics');
  return data;
}

export async function getResourceExhaustions(
  gcpAgentConfigs: GcpAgentConfiguration[],
  projectId: string,
  sinceNumberOfMinutes: number = DEFAULT_PREEMPTION_WINDOW_MINUTES
) {
  return getLoggingMetrics(gcpAgentConfigs, projectId, 'instance-resource-exhausted', sinceNumberOfMinutes);
}

// This is a pretty confusing algorithm to follow... look at the tests for some example numbers which should help show what it's doing
export function getZoneWeighting(requestedZones: string[], zoneScores: ZoneScores) {
  let maxScore = 0;
  const zoneWeightings: Record<string, any> = {};

  let zones: string[];

  // Don't use any zones that have had MAX_PREEMPTIONS_PER_WINDOW preemptions or more in the time window
  zones = requestedZones.filter((zone) => {
    return !zoneScores[zone] || zoneScores[zone] <= MAX_PREEMPTIONS_PER_WINDOW;
  });

  // If all or too many zones get filtered out, just use the 3 with the fewest preemptions
  if (!zones.length || (requestedZones.length > 5 && zones.length < 3)) {
    zones = requestedZones
      .sort((a, b) => {
        return (zoneScores[a] ?? 0) - (zoneScores[b] ?? 0);
      })
      .slice(0, 3);
  }

  // Only use region scores if one of the zones is an overridden one
  const shouldUseRegionScores = !!zones.find((zone) => zone.substring(0, zone.lastIndexOf('-')) in DEFAULT_REGION_SCORES);

  // Higher score = less likely to be used
  for (const zone of zones) {
    const region = zone.substring(0, zone.lastIndexOf('-'));
    const regionScore = shouldUseRegionScores ? DEFAULT_REGION_SCORES[region] ?? DEFAULT_REGION_SCORE : 0;

    // Initial score for each zone is preemptions + default region score + 1
    // The +1 is mostly to make the math work.. It doesn't work if there are 0s
    const score = (zoneScores[zone] ?? 0) + 1 + regionScore;
    const zoneWrapped = {
      zone: zone,
      preemptions: zoneScores[zone] ?? 0,
      score: score,
      weighting: 0,
    };
    zoneWeightings[zone] = zoneWrapped;
    maxScore = Math.max(maxScore, score);
  }

  let adjustedTotal = 0;
  for (const zone of Object.values(zoneWeightings)) {
    // Create an adjusted score that's flipped, and expressed relative to the maximum score: higher adjusted score = higher chance of being chosen
    zone.adjustedScore = maxScore / zone.score;
    adjustedTotal += zone.adjustedScore;
  }

  const finalWeightings: ZoneWeighting = {};
  for (const zone of Object.values(zoneWeightings)) {
    // The final weighting is just a percentage contribution to the sum of adjusted scores, which we will use as a probability of being picked
    // e.g. final weighting of 0.3 for a given zone means that it will be chosen 30% of the time
    zone.weighting = +(zone.adjustedScore / adjustedTotal).toFixed(3);
    finalWeightings[zone.zone] = zone.weighting;
  }

  return finalWeightings;
}

// Move this to GCP? it would be useful for non-spot picking as well
export function pickZone(zoneWeighting: ZoneWeighting) {
  let sum = 0;
  let rand = Math.random();

  for (let zone in zoneWeighting) {
    sum += zoneWeighting[zone];
    if (sum >= rand) {
      return zone;
    }
  }

  // Failsafe in case the weightings don't quite add up to 1
  return Object.keys(zoneWeighting).reverse()[0];
}

export function getZoneWeightingFromMetrics(zones: string[], preemptions: MetricsResult, resourceExhaustions: MetricsResult) {
  const zoneScores: ZoneScores = {};
  for (const set of [preemptions, resourceExhaustions]) {
    for (const zone in set) {
      zoneScores[zone] = zoneScores[zone] ?? 0;
      zoneScores[zone] += set[zone];
    }
  }

  return getZoneWeighting(zones, zoneScores);
}

export function getZone(zones: string[], preemptions: MetricsResult, resourceExhaustions: MetricsResult) {
  const zoneWeighting = getZoneWeightingFromMetrics(zones, preemptions, resourceExhaustions);
  return pickZone(zoneWeighting);
}
