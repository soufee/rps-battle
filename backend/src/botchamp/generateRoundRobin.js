import { getAllBots } from './BotDiscovery.js';

/**
 * Generate a full round-robin schedule.
 * Each bot plays every other bot exactly once as top and once as bottom (or configurable).
 */
export function generateRoundRobin(options = {}) {
  const double = options.double !== false; // play each pair twice (home/away)
  const bots = getAllBots().map(b => b.id);
  const rounds = [];
  let roundNum = 1;

  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const matches = [{ top: bots[i], bottom: bots[j] }];
      if (double) {
        matches.push({ top: bots[j], bottom: bots[i] });
      }
      rounds.push({ round: roundNum++, matches });
    }
  }

  return {
    name: `Круговой турнир (${bots.length} ботов, ${double ? '2 круга' : '1 круг'})`,
    generated: true,
    rounds
  };
}
