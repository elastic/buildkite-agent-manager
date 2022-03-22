import monitoring from '@google-cloud/monitoring';

import { globalCache } from './cache';

const client = new monitoring.MetricServiceClient();

export type PreemptionsResult = Record<string, number>;
export type ZoneWeighting = Record<string, number>;

// The listed regions here are much cheaper than all of the other regions
// So let's weight all other regions so that we use them less often
const DEFAULT_REGION_SCORE = 5;
export const DEFAULT_REGION_SCORES = {
  'northamerica-northeast2': 0,
  'europe-west2': 0,
  'southamerica-east1': 0,
  'asia-south2': 0,
};

export async function getPreemptionsWithCache(projectId: string, sinceNumberOfMinutes: number = 30): Promise<PreemptionsResult> {
  const cacheKey = `preemptions-${projectId}-${sinceNumberOfMinutes}`;
  let preemptions: PreemptionsResult;
  try {
    preemptions = await getPreemptions(projectId, sinceNumberOfMinutes);
    globalCache.set(cacheKey, preemptions, 60 * 10);
  } catch (ex: any) {
    console.error(ex.toString());
  }

  return preemptions ?? globalCache.get(cacheKey);
}

export async function getPreemptions(projectId: string, sinceNumberOfMinutes: number = 30) {
  const filter = 'metric.type="logging.googleapis.com/user/instance-preemptions"';

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
    // view:
  };

  const [timeSeries] = await client.listTimeSeries(request);
  const results: PreemptionsResult = {};

  timeSeries.forEach((data) => {
    const zone = data.resource.labels.zone;

    // TODO should we separate things out by CPU type?
    // const instanceName = data.metric.labels.resourceName.substring(data.metric.labels.resourceName.lastIndexOf('/') + 1);
    // can get cpu type and count from agent config data based on basename
    results[zone] = results[zone] ?? 0;
    results[zone] += 1;
  });

  return results;
}

// This is a pretty confusing algorithm to follow... look at the tests for some example numbers which should help show what it's doing
export function getZoneWeighting(requestedZones: string[], preemptions: PreemptionsResult) {
  let maxScore = 0;
  const zoneWeightings: Record<string, any> = {};

  // Don't use any zones that have had 5 preemptions or more in the time window
  const zones = requestedZones.filter((zone) => {
    return !preemptions[zone] || preemptions[zone] < 5;
  });

  // Only use region scores if one of the zones is an overridden one
  const shouldUseRegionScores = !!zones.find((zone) => zone.substring(0, zone.lastIndexOf('-')) in DEFAULT_REGION_SCORES);

  // Higher score = less likely to be used
  for (const zone of zones) {
    const region = zone.substring(0, zone.lastIndexOf('-'));
    const regionScore = shouldUseRegionScores ? DEFAULT_REGION_SCORES[region] ?? DEFAULT_REGION_SCORE : 0;

    // Initial score for each zone is preemptions + default region score + 1
    // The +1 is mostly to make the math work.. It doesn't work if there are 0s
    const score = (preemptions[zone] ?? 0) + 1 + regionScore;
    const zoneWrapped = {
      zone: zone,
      preemptions: preemptions[zone] ?? 0,
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

export function getZone(zones: string[], preemptions: PreemptionsResult) {
  const zoneWeighting = getZoneWeighting(zones, preemptions);
  return pickZone(zoneWeighting);
}
