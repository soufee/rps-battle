import { getBotDisplayName } from './BotDiscovery.js';

class Standings {
  constructor() {
    this.table = {}; // botId -> stats
  }

  reset() {
    this.table = {};
  }

  /**
   * Process a match result and update standings.
   */
  processMatch(matchResult) {
    const { topBotId, bottomBotId, winner } = matchResult;

    this._ensureBot(topBotId);
    this._ensureBot(bottomBotId);

    const top = this.table[topBotId];
    const bottom = this.table[bottomBotId];

    // Games played
    top.games += 1;
    bottom.games += 1;

    if (winner === 'top') {
      top.wins += 1;
      top.points += 3;
      bottom.losses += 1;
    } else if (winner === 'bottom') {
      bottom.wins += 1;
      bottom.points += 3;
      top.losses += 1;
    } else {
      // draw
      top.draws += 1;
      bottom.draws += 1;
      top.points += 1;
      bottom.points += 1;
    }
  }

  _ensureBot(id) {
    if (!this.table[id]) {
      this.table[id] = {
        id,
        name: getBotDisplayName(id),
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        points: 0
      };
    }
  }

  getSortedTable() {
    return Object.values(this.table)
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.games - b.games; // fewer games first if tie
      });
  }

  toJSON() {
    return {
      updatedAt: new Date().toISOString(),
      standings: this.getSortedTable()
    };
  }

  /**
   * Generate nice markdown tournament table.
   */
  generateMarkdownReport(tournamentName = 'Чемпионат') {
    const table = this.getSortedTable();
    const lines = [
      `# ${tournamentName}`,
      ``,
      `Обновлено: ${new Date().toLocaleString('ru-RU')}`,
      ``,
      `| Место | Бот          | Игр | Побед | Поражений | Ничьих | Очки |`,
      `|-------|--------------|-----|-------|-----------|--------|------|`
    ];

    table.forEach((row, idx) => {
      lines.push(
        `| ${idx + 1} | ${row.name} | ${row.games} | ${row.wins} | ${row.losses} | ${row.draws} | **${row.points}** |`
      );
    });

    lines.push(``);
    lines.push(`> Очки: победа = 3, ничья = 1, поражение = 0`);
    return lines.join('\n');
  }
}

export default Standings;
