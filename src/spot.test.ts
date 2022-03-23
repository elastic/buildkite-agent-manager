import { getZoneWeighting, pickZone } from './spot';

describe('spot', () => {
  describe('getZoneWeighting', () => {
    it('should return the correct zone weighting', () => {
      const zones = ['zone-1', 'zone-2', 'zone-3'];
      const preemptions = {
        'zone-1': 0,
        'zone-2': 1,
        'zone-3': 2,
      };

      const zoneWeightings = getZoneWeighting(zones, preemptions);
      expect(zoneWeightings).toEqual({
        'zone-1': 0.545,
        'zone-2': 0.273,
        'zone-3': 0.182,
      });
    });

    it('should return a zone weighting if only some of the zones have preemptions', () => {
      const zones = ['zone-1', 'zone-2', 'zone-3'];
      const preemptions = {
        'zone-3': 2,
      };

      const zoneWeightings = getZoneWeighting(zones, preemptions);
      expect(zoneWeightings).toEqual({
        'zone-1': 0.429,
        'zone-2': 0.429,
        'zone-3': 0.143,
      });
    });

    it('should return equal zone weighting if the preemptions are all equal', () => {
      const zones = ['zone-1', 'zone-2', 'zone-3'];
      const preemptions = {
        'zone-1': 4,
        'zone-2': 4,
        'zone-3': 4,
      };

      const zoneWeightings = getZoneWeighting(zones, preemptions);
      expect(zoneWeightings).toEqual({
        'zone-1': 0.333,
        'zone-2': 0.333,
        'zone-3': 0.333,
      });
    });

    it('should return different zone weighting if the preemptions are all equal but one region is a custom weighted one', () => {
      const zones = ['northamerica-northeast2-a', 'zone-2', 'zone-3'];
      const preemptions = {
        'northamerica-northeast2-a': 2,
        'zone-2': 2,
        'zone-3': 2,
      };

      const zoneWeightings = getZoneWeighting(zones, preemptions);
      expect(zoneWeightings).toEqual({
        'northamerica-northeast2-a': 0.571,
        'zone-2': 0.214,
        'zone-3': 0.214,
      });
    });

    it('should return equal zone weighting if there are no preemptions', () => {
      const zones = ['zone-1', 'zone-2', 'zone-3'];
      const preemptions = {};

      const zoneWeightings = getZoneWeighting(zones, preemptions);
      expect(zoneWeightings).toEqual({
        'zone-1': 0.333,
        'zone-2': 0.333,
        'zone-3': 0.333,
      });
    });
  });

  it('pickZone', () => {
    const zones = ['zone-a', 'zone-b', 'zone-c', 'zone-d', 'zone-e'];

    const w = getZoneWeighting(zones, {
      'zone-a': 1,
      'zone-b': 4,
    });

    const values = {};
    for (let i = 0; i < 1000; i++) {
      const zone = pickZone(w);
      values[zone] = values[zone] ?? 0;
      values[zone] += 1;
    }

    for (const zone of zones) {
      expect(values[zone]).toBeGreaterThan(0);
    }

    // The zones are picked using a weighted random distribution, so there's randomness here
    // But with 1000 iterations, all of the following should generally be true
    expect(values['zone-d']).toBeGreaterThan(values['zone-a']);
    expect(values['zone-e']).toBeGreaterThan(values['zone-a']);
    expect(values['zone-a']).toBeGreaterThan(values['zone-b']);
  });
});
